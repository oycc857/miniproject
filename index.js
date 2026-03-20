const express = require('express');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');
const OSS = require('ali-oss');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// OSS 客户端（需在云托管环境变量里设置这四个值）
const ossClient = new OSS({
  region:          process.env.OSS_REGION,
  accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket:          process.env.OSS_BUCKET
});

// ====================================================
// 1. 阿里云百炼配置
// ====================================================
const ALIYUN_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY,
  host:   'https://dashscope.aliyuncs.com',
  model:  'cosyvoice-v3.5-flash'
};

// ====================================================
// 2. 数据库连接
// ====================================================
const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'nodejs_demo',
  process.env.MYSQL_USERNAME || 'root',
  process.env.MYSQL_PASSWORD || '147896325oycC',
  {
    host: process.env.MYSQL_ADDRESS ? process.env.MYSQL_ADDRESS.split(':')[0] : '10.2.112.140',
    dialect: 'mysql',
    port: 3306,
    dialectOptions: { connectTimeout: 10000 },
    logging: false
  }
);

// ====================================================
// 3. 数据库表定义
// ====================================================
const User = sequelize.define('Users', {
  openid:     { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName:   { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl:  { type: DataTypes.STRING, defaultValue: '' },
  voice_name: { type: DataTypes.STRING, defaultValue: null },
  task_id:    { type: DataTypes.STRING, defaultValue: null },
  speakerId:  { type: DataTypes.STRING, defaultValue: null },
  status:     { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'Users', timestamps: true, underscored: false });

const UserVoice = sequelize.define('UserVoice', {
  openid:    { type: DataTypes.STRING },
  voiceName: { type: DataTypes.STRING },
  speakerId: { type: DataTypes.STRING },
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },
  audioUrl:  { type: DataTypes.STRING(500), defaultValue: null },
}, { tableName: 'UserVoices', timestamps: true, underscored: false });

// ====================================================
// 4. 登录
// ====================================================
app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body;
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });
  try {
    const [user, created] = await User.findOrCreate({
      where: { openid },
      defaults: { openid, nickName: nickName || '微信用户', avatarUrl: avatarUrl || '' }
    });
    if (!created && (nickName || avatarUrl)) {
      if (nickName) user.nickName = nickName;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
    }
    res.json({ success: true, data: user });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ success: false, msg: '数据库错误: ' + err.message });
  }
});

// ====================================================
// 5. 获取用户音色列表
// ====================================================
app.get('/get_voices', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).send('Unauthorized');
  try {
    const voices = await UserVoice.findAll({
      where: { openid },
      order: [['id', 'DESC']]  // 用 id 排序，避免 createdAt 为 NULL 时报错
    });
    res.json({ success: true, list: voices });
  } catch (err) {
    console.error('get_voices 失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 6. 上传音频并发起克隆训练（阿里云版，完全免费）
// ====================================================
app.post('/start_clone', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, voiceName } = req.body;

  if (!audioUrl || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  let ossKey = null;

  try {
    // 防止同一用户重复提交
    const existingVoice = await UserVoice.findOne({ where: { openid, status: 0 } });
    if (existingVoice) {
      return res.status(400).json({
        success: false,
        msg: '你有一个音色正在训练中，请等待完成后再提交'
      });
    }

    // 1. 下载音频文件到内存
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioRes.data);

    // 2. 上传到阿里云 OSS（阿里云自己可以访问 OSS，URL 干净无问题）
    ossKey = `temp_voices/${openid.slice(-6)}_${Date.now()}.mp3`;
    await ossClient.put(ossKey, audioBuffer, { headers: { 'x-oss-object-acl': 'public-read' } });
    const ossUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey}`;
    console.log('OSS上传成功，URL:', ossUrl);

    // 3. 生成唯一前缀
    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    // 4. 调用阿里云声音复刻（用 OSS URL，同一家公司必然可访问）
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          ossUrl,
          prefix:       prefix
        }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        }
      }
    );

    if (response.data.output && response.data.output.voice_id) {
      const voiceId = response.data.output.voice_id;
      // 不立即删除 OSS 文件！阿里云会异步下载，等训练完成后再删
      // ossKey 存到 audioUrl 字段，查询状态成功后删除
      await UserVoice.create({
        openid,
        voiceName: voiceName || '我的音色',
        speakerId: voiceId,
        audioUrl:  ossUrl,  // 存完整 OSS URL，TTS 合成时需要传给阿里云
        status: 0
      });
      res.json({ success: true, speakerId: voiceId });
    } else {
      ossClient.delete(ossKey).catch(() => {});
      console.error('阿里云返回错误:', JSON.stringify(response.data));
      res.status(500).json({
        success: false,
        msg: '克隆失败: ' + (response.data.message || JSON.stringify(response.data))
      });
    }
  } catch (err) {
    if (ossKey) ossClient.delete(ossKey).catch(() => {});
    console.error('start_clone 异常:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      msg: err.response?.data?.message || err.message
    });
  }
});

// ====================================================
// 7. 查询克隆训练状态（阿里云版）
// 状态：DEPLOYING=训练中, OK=完成, UNDEPLOYED=失败
// ====================================================
app.post('/check_clone_status', async (req, res) => {
  const { speakerId } = req.body;
  if (!speakerId) return res.status(400).json({ success: false, msg: '缺少 speakerId' });

  try {
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: { action: 'query_voice', voice_id: speakerId }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        }
      }
    );

    const aliyunStatus = response.data.output?.status;

    if (aliyunStatus === 'OK') {
      // 训练完成，OSS 文件保留！TTS 合成每次都需要用这个 URL
      await UserVoice.update({ status: 1 }, { where: { speakerId } });
      res.json({ success: true, status: 2 });
    } else if (aliyunStatus === 'UNDEPLOYED') {
      // 训练失败，删除 OSS 临时文件
      const voice = await UserVoice.findOne({ where: { speakerId } });
      if (voice && voice.audioUrl) {
        // audioUrl 现在存完整 URL，需要提取 key
        const key = voice.audioUrl.replace(/^https?:\/\/[^/]+\//, '');
        ossClient.delete(key).catch(() => {});
      }
      await UserVoice.update({ status: 2 }, { where: { speakerId } });
      res.json({ success: true, status: 3 });
    } else {
      res.json({ success: true, status: 1 });
    }
  } catch (err) {
    console.error('查询状态失败:', err.response?.data || err.message);
    res.status(500).json({ success: false, msg: '查询失败: ' + err.message });
  }
});

// ====================================================
// 8. 重新训练已有音色（阿里云版，仍然免费）
// ====================================================
app.post('/retrain_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, speakerId } = req.body;

  if (!audioUrl || !speakerId || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    const voice = await UserVoice.findOne({ where: { speakerId, openid } });
    if (!voice) {
      return res.status(403).json({ success: false, msg: '音色不存在或无权限' });
    }

    // 先删除旧音色
    try {
      await axios.post(
        `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
        { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: speakerId } },
        { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.log('删除旧音色失败（忽略）:', e.message);
    }

    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    // 下载音频并上传到 OSS，供阿里云访问
    const audioRes2 = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const ossKey2 = `temp_voices/retrain_${openid.slice(-6)}_${Date.now()}.mp3`;
    await ossClient.put(ossKey2, Buffer.from(audioRes2.data), { headers: { 'x-oss-object-acl': 'public-read' } });
    const ossUrl2 = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey2}`;

    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          ossUrl2,
          prefix:       prefix
        }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        }
      }
    );

    if (response.data.output && response.data.output.voice_id) {
      const newVoiceId = response.data.output.voice_id;
      // 存 ossUrl（完整 URL），TTS 合成时需要
      await voice.update({ speakerId: newVoiceId, audioUrl: ossUrl2, status: 0 });
      res.json({ success: true, speakerId: newVoiceId });
    } else {
      ossClient.delete(ossKey2).catch(() => {});
      console.error('重训阿里云返回错误:', JSON.stringify(response.data));
      res.status(500).json({ success: false, msg: '重训失败: ' + JSON.stringify(response.data) });
    }
  } catch (err) {
    console.error('retrain_voice 异常:', err.response?.data || err.message);
    res.status(500).json({ success: false, msg: err.response?.data?.message || err.message });
  }
});

// ====================================================
// 9. 音色改名
// ====================================================
app.post('/rename_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { id, voiceName } = req.body;
  if (!id || !voiceName) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }
  try {
    const [count] = await UserVoice.update(
      { voiceName },
      { where: { id, openid } }
    );
    if (count === 0) {
      return res.status(404).json({ success: false, msg: '音色不存在或无权限' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('改名失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});


// ====================================================
// 10. 私人音色 TTS 合成（阿里云 cosyvoice-v3.5-flash）
// ====================================================
app.post('/tts_private', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { text, speakerId } = req.body;

  if (!text || !speakerId) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    // 从数据库取 audioUrl
    const voice = await UserVoice.findOne({ where: { speakerId, openid } });
    if (!voice) {
      return res.status(403).json({ success: false, msg: '音色不存在或无权限' });
    }

    console.log('【私人TTS】speakerId =', speakerId);
    console.log('【私人TTS】audioUrl =', voice.audioUrl);

    const response = await axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech',
      {
        model:           'cosyvoice-v3.5-flash',
        input:           text,
        voice:           speakerId,
        response_format: 'mp3'
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    const ct = response.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      const errObj = JSON.parse(Buffer.from(response.data).toString());
      console.error('【私人TTS】阿里云错误:', JSON.stringify(errObj));
      return res.status(500).json({ success: false, msg: errObj.message || '合成失败' });
    }

    // 上传到微信云存储
    // 直接返回 base64，让云函数上传
    const base64Audio = Buffer.from(response.data).toString('base64');
    res.json({ success: true, audio: base64Audio });

  } catch (err) {
    let errMsg = err.message;
    try {
      if (err.response?.data) {
        const t = Buffer.from(err.response.data).toString().trim();
        if (t) errMsg = JSON.parse(t).message || t;
      }
    } catch (e) {}
    console.error('【私人TTS】异常:', errMsg);
    res.status(500).json({ success: false, msg: errMsg });
  }
});

// ====================================================
// 11. 启动服务
// ====================================================
const port = process.env.PORT || 80;
app.listen(port, async () => {
  console.log('Server running on port', port);
  await sequelize.sync();
  console.log('数据库同步完成');
});
