const express = require('express');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 用于临时存放音频文件，供阿里云下载
// 微信云存储的临时链接阿里云无法访问，需要中转
const TEMP_DIR = os.tmpdir();
app.use('/temp_audio', express.static(TEMP_DIR));

// ====================================================
// 1. 阿里云百炼配置
// ====================================================
const ALIYUN_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || 'sk-4c4aefb6e8244b27aa100d8fff592607',
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

  let tempFilePath = null;

  try {
    // 防止同一用户重复提交
    const existingVoice = await UserVoice.findOne({ where: { openid, status: 0 } });
    if (existingVoice) {
      return res.status(400).json({
        success: false,
        msg: '你有一个音色正在训练中，请等待完成后再提交'
      });
    }

    // ── 核心：把音频下载到后端服务器，再用后端公网地址给阿里云 ──
    // 原因：阿里云服务器无法访问微信云存储的临时链接
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const fileName = `audio_${openid.slice(-6)}_${Date.now()}.mp3`;
    tempFilePath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(tempFilePath, Buffer.from(audioRes.data));

    // 构建后端自身的公网地址供阿里云访问
    // 微信云托管会注入 HOST 环境变量，或者用 req.headers.host
    const host = process.env.SERVER_HOST || req.headers['x-forwarded-host'] || req.headers.host;
    const publicAudioUrl = `https://${host}/temp_audio/${fileName}`;

    // 生成唯一前缀（只能小写字母+数字，小于10字符）
    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    // 调用阿里云声音复刻接口（免费）
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          publicAudioUrl,  // 用后端自己的地址，阿里云可访问
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

    // 阿里云拿完文件后删除临时文件
    try { fs.unlinkSync(tempFilePath); } catch(e) {}

    if (response.data.output && response.data.output.voice_id) {
      const voiceId = response.data.output.voice_id;
      await UserVoice.create({
        openid,
        voiceName: voiceName || '我的音色',
        speakerId: voiceId,
        audioUrl:  audioUrl,
        status: 0
      });
      res.json({ success: true, speakerId: voiceId });
    } else {
      console.error('阿里云返回错误:', response.data);
      res.status(500).json({
        success: false,
        msg: '克隆失败: ' + (response.data.message || JSON.stringify(response.data))
      });
    }
  } catch (err) {
    // 出错也清理临时文件
    if (tempFilePath) try { fs.unlinkSync(tempFilePath); } catch(e) {}
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
      await UserVoice.update({ status: 1 }, { where: { speakerId } });
      res.json({ success: true, status: 2 }); // 2=完成，兼容前端轮询
    } else if (aliyunStatus === 'UNDEPLOYED') {
      await UserVoice.update({ status: 2 }, { where: { speakerId } });
      res.json({ success: true, status: 3 }); // 3=失败
    } else {
      res.json({ success: true, status: 1 }); // 1=训练中
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

    // 下载音频到后端做中转（微信临时链接阿里云无法访问）
    const audioRes2 = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const fileName2 = `retrain_${openid.slice(-6)}_${Date.now()}.mp3`;
    const tempPath2 = path.join(TEMP_DIR, fileName2);
    fs.writeFileSync(tempPath2, Buffer.from(audioRes2.data));
    const host2 = process.env.SERVER_HOST || req.headers['x-forwarded-host'] || req.headers.host;
    const publicUrl2 = `https://${host2}/temp_audio/${fileName2}`;

    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          publicUrl2,
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

    try { fs.unlinkSync(tempPath2); } catch(e) {}

    if (response.data.output && response.data.output.voice_id) {
      const newVoiceId = response.data.output.voice_id;
      await voice.update({ speakerId: newVoiceId, audioUrl, status: 0 });
      res.json({ success: true, speakerId: newVoiceId });
    } else {
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
// 10. 启动服务
// ====================================================
const port = process.env.PORT || 80;
app.listen(port, async () => {
  console.log('Server running on port', port);
  await sequelize.sync();
  console.log('数据库同步完成');
});
