const express = require('express');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ====================================================
// 1. 火山引擎配置（替换成你自己的）
// ====================================================
const VOLC_CONFIG = {
  appid: '2480093223',
  token: 'caZWuEhKg2TWjHZWXFznm5GPWOr21AqL',
  host: 'https://openspeech.bytedance.com'
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

// 用户表（保持不变）
const User = sequelize.define('Users', {
  openid:    { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName:  { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' },
  speakerId: DataTypes.STRING,
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'Users', timestamps: true });

// 用户音色表（保持不变，status: 0=训练中, 1=完成, 2=失败）
const UserVoice = sequelize.define('UserVoice', {
  openid:    DataTypes.STRING,
  voiceName: DataTypes.STRING,
  speakerId: DataTypes.STRING,
  taskId:    DataTypes.STRING,
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'UserVoices', timestamps: true });

// ====================================================
// 【新增】音色 Slot 池表
// 说明：你需要提前在火山引擎控制台购买 S_xxxxx 格式的音色 slot
//       然后通过下面的 /admin/add_slots 接口把这些 ID 存进数据库
//       status: 0=未分配, 1=已分配给用户
// ====================================================
const VoiceSlot = sequelize.define('VoiceSlot', {
  speakerId: { type: DataTypes.STRING, allowNull: false, unique: true }, // S_xxxxx
  openid:    { type: DataTypes.STRING, defaultValue: null },             // 分配给哪个用户
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },               // 0=空闲, 1=已用
}, { tableName: 'VoiceSlots', timestamps: true });

// ====================================================
// 4. 路由：登录（保持原有逻辑不变）
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
// 5. 路由：获取用户音色列表（保持不变）
// ====================================================
app.get('/get_voices', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).send('Unauthorized');
  try {
    const voices = await UserVoice.findAll({
      where: { openid },
      order: [['id', 'DESC']]
    });
    res.json({ success: true, list: voices });
  } catch (err) {
    console.error('get_voices 失败:', err);
  res.status(500).json({ success: false, msg: err.message }); // 👈 改这里
  }
});

// 【新增】路由：音色改名
app.post('/rename_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { id, voiceName } = req.body;
 
  if (!id || !voiceName) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }
 
  try {
    // 只能改自己的音色，用 openid 做校验防止越权
    const [count] = await UserVoice.update(
      { voiceName },
      { where: { id, openid } }
    );
 
    if (count === 0) {
      return res.status(404).json({ success: false, msg: '音色不存在或无权限' });
    }
 
    res.json({ success: true });
  } catch (err) {
    console.error('get_voices 失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 6. 【新增】管理员接口：批量录入从控制台买来的 slot
// 使用方法：用 Postman/curl 调用一次即可，不需要每次调
// 示例请求体：{ "slots": ["S_abc123", "S_def456", "S_ghi789"] }
// ====================================================
app.post('/admin/add_slots', async (req, res) => {
  const { slots } = req.body;
  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ msg: 'slots 必须是数组' });
  }
  try {
    const results = [];
    for (const speakerId of slots) {
      const [slot, created] = await VoiceSlot.findOrCreate({
        where: { speakerId },
        defaults: { speakerId, status: 0 }
      });
      results.push({ speakerId, created });
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error('添加 slot 失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 7. 路由：上传音频并发起克隆训练（核心修复）
// ====================================================
app.post('/start_clone', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, voiceName } = req.body;

  if (!audioUrl || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    // ----------------------------------------
    // 【修复1】从数据库取一个空闲的真实 slot
    // 原来代码是自己造 spk_xxx，火山引擎不认
    // ----------------------------------------
    const slot = await VoiceSlot.findOne({ where: { status: 0 } });
    if (!slot) {
      return res.status(500).json({
        success: false,
        msg: '音色 slot 不足，请管理员在控制台购买更多并录入系统'
      });
    }
    const spk_id = slot.speakerId; // 真实的 S_xxxxx

    // A. 下载音频并转 Base64
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const base64Audio = Buffer.from(audioRes.data).toString('base64');

    // B. 调用火山声音复刻接口
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/mega_tts/audio/upload`,
      {
        appid:      VOLC_CONFIG.appid,
        speaker_id: spk_id,
        audios: [{
          audio_bytes:  base64Audio,
          audio_format: 'mp3'
        }],
        source:     2, // 2=声音复刻
        language:   0, // 0=中文
        model_type: 1  // 1=2.0基础模型
      },
      {
        headers: {
          'Content-Type': 'application/json',
          // ----------------------------------------
          // 【修复2】Bearer 后面必须有空格再加分号
          // 原来写的是 "Bearer;" 少了空格导致鉴权失败
          // ----------------------------------------
          'Authorization': 'Bearer; ' + VOLC_CONFIG.token,
          'Resource-Id':   'volc.megatts.voiceclone'
        }
      }
    );

    // ----------------------------------------
    // 【修复3】正确判断火山引擎的响应格式
    // 原来判断 message === 'Success' 是错的
    // 正确格式是 BaseResp.StatusCode === 0
    // ----------------------------------------
    if (response.data.BaseResp && response.data.BaseResp.StatusCode === 0) {
      // 标记该 slot 已被分配给此用户
      await slot.update({ status: 1, openid });

      // 写入用户音色记录，status=0 表示训练中
      await UserVoice.create({
        openid,
        voiceName: voiceName || '我的音色',
        speakerId: spk_id,
        status: 0
      });

      res.json({ success: true, speakerId: spk_id });
    } else {
      console.error('火山引擎返回错误:', response.data);
      res.status(500).json({
        success: false,
        msg: '火山错误: ' + (response.data.BaseResp?.StatusMessage || '未知错误')
      });
    }

  } catch (err) {
    console.error('start_clone 异常:', err.message);
    res.status(500).json({ success: false, msg: '服务器处理失败: ' + err.message });
  }
});

// ====================================================
// 8. 【新增】路由：查询克隆训练状态
// 小程序每隔几秒调一次，直到 status=2（完成）
// ====================================================
app.post('/check_clone_status', async (req, res) => {
  const { speakerId } = req.body;
  if (!speakerId) return res.status(400).json({ success: false, msg: '缺少 speakerId' });

  try {
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/mega_tts/status`,
      {
        appid:      VOLC_CONFIG.appid,
        speaker_id: speakerId
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer; ' + VOLC_CONFIG.token,
          'Resource-Id':   'volc.megatts.voiceclone'
        }
      }
    );

    const volcStatus = response.data.status;
    // 火山状态码：1=训练中, 2=成功, 3=失败, 4=active(可用)

    // 如果训练完成，更新数据库里的状态
    if (volcStatus === 2 || volcStatus === 4) {
      await UserVoice.update({ status: 1 }, { where: { speakerId } });
    } else if (volcStatus === 3) {
      await UserVoice.update({ status: 2 }, { where: { speakerId } });
    }

    res.json({ success: true, status: volcStatus });
  } catch (err) {
    console.error('查询状态失败:', err.message);
    res.status(500).json({ success: false, msg: '查询失败' });
  }
});

// ====================================================
// 9. 【新增】路由：文字合成语音（TTS）
// 用户训练完成后，输入文字，用自己的音色合成语音
// 返回音频的 base64，小程序端再播放
// ====================================================
app.post('/tts', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { text, speakerId } = req.body;

  if (!text || !speakerId) {
    return res.status(400).json({ success: false, msg: '缺少 text 或 speakerId' });
  }

  try {
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/tts`,
      {
        app: {
          appid:   VOLC_CONFIG.appid,
          token:   VOLC_CONFIG.token,
          cluster: 'volcano_mega' // 使用克隆音色必须用这个 cluster
        },
        user: { uid: openid },
        audio: {
          voice_type:  speakerId, // 填写用户克隆好的 S_xxxxx
          encoding:    'mp3',
          speed_ratio: 1.0,
          volume_ratio: 1.0,
          pitch_ratio:  1.0
        },
        request: {
          reqid:     `req_${Date.now()}`,
          text:      text,
          text_type: 'plain',
          operation: 'query'
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer; ' + VOLC_CONFIG.token
        }
      }
    );

    // 火山返回的是 base64 音频数据
    if (response.data.code === 3000) {
      const audioBase64 = response.data.data;
      res.json({ success: true, audio: audioBase64 }); // 返回 base64
    } else {
      res.status(500).json({
        success: false,
        msg: 'TTS 失败: ' + (response.data.message || '未知错误')
      });
    }
  } catch (err) {
    console.error('TTS 失败:', err.message);
    res.status(500).json({ success: false, msg: 'TTS 请求失败' });
  }
});

// ====================================================
// 10. 启动服务
// ====================================================
const port = process.env.PORT || 80;
app.listen(port, async () => {
  console.log('Server running on port', port);
  // sync() 会自动创建不存在的表（包括新加的 VoiceSlots 表）
  await sequelize.sync();
  console.log('数据库同步完成');
});
