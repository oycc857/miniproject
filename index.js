const express = require('express');
const multer = require('multer');
const { Service } = require('@volcengine/openapi');
const axios = require('axios'); // 引入 axios
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const upload = multer({ dest: '/tmp/' });

// 必须：调大体积限制，Base64 字符串很大
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));

// --- 数据库连接修正 ---
const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'nodejs_demo',
  process.env.MYSQL_USERNAME || 'root',
  process.env.MYSQL_PASSWORD || '147896325oycC',
  {
    // 关键修正：确保 host 不带端口号
    host: process.env.MYSQL_ADDRESS ? process.env.MYSQL_ADDRESS.split(':')[0] : '10.2.112.140', 
    dialect: 'mysql',
    port: 3306,
    dialectOptions: { connectTimeout: 10000 },
    logging: false 
  }
);

// --- 模型定义 ---
const User = sequelize.define('Users', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' }
}, { tableName: 'Users', timestamps: true });

const UserVoice = sequelize.define('UserVoice', {
  openid: DataTypes.STRING,
  voiceName: DataTypes.STRING,
  speakerId: DataTypes.STRING, // 训练完成后存储
  taskId: DataTypes.STRING,    // 存储任务ID用于轮询
  status: { type: DataTypes.INTEGER, defaultValue: 0 }, // 0: 训练中, 1: 成功, 2: 失败
}, { tableName: 'UserVoices', timestamps: true });

// --- 初始化火山 SDK ---
// 初始化部分改用通用构造函数
const vcllClient = new Service({
  host: 'openspeech.bytedance.com',
  region: 'cn-north-1',
  accessKeyId: process.env.VOLC_AK,
  secretAccessKey: process.env.VOLC_SK,
  protocol: 'https', // 显式指定协议
  serviceName: 'custom_tts' // 对应火山的自定义语音服务
});

// 登录接口
app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body;
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });

  try {
    await User.sync({ alter: true });
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: { openid, nickName: nickName || '微信用户', avatarUrl: avatarUrl || '' }
    });
    if (!created) {
      user.nickName = nickName || user.nickName;
      user.avatarUrl = avatarUrl || user.avatarUrl;
      await user.save();
    }
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, msg: '数据库错误' });
  }
});

// 上传并克隆接口
// 新增：处理 Base64 格式的音频克隆请求
app.post('/upload-base64', async (req, res) => {
  const { audioData, openid } = req.body;
  if (!audioData) {
    return res.status(400).send({ success: false, msg: '缺少音频数据' });
  }

  try {
    // 1. 直接将 Base64 发送给火山引擎（火山 API 本身就支持 Base64）
    const params = {
      Action: 'CreateTtsCustomizationSpeaker',
      Version: '2023-11-01',
      Appid: process.env.VOLC_APPID,
      ServiceId: process.env.VOLC_SERVICE_ID, // 也就是你截图里的 VoiceCloning2000...
      SpeakerName: `user_${openid ? openid.slice(-5) : 'test'}`,
      AudioFormat: 'mp3',
      SampleRate: 16000,
      AudioData: audioData // 直接把前端传来的 base64 塞进去
    };

    // vcllClient 是你之前定义的 Service 实例
    const result = await vcllClient.request('CreateTtsCustomizationSpeaker', params);

    console.log('火山返回结果:', result);

    if (result.Data && result.Data.SpeakerId) {
      // 存储到数据库逻辑...
      res.send({ success: true, speakerId: result.Data.SpeakerId });
    } else {
      res.send({ success: false, msg: result.ResponseMetadata?.Error?.Message || '克隆失败' });
    }
  } catch (err) {
    console.error('调用火山报错:', err);
    res.status(500).send({ success: false, msg: '后端转发失败' });
  }
});

app.get('/get_voices', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).send('Unauthorized');

  try {
    const voices = await UserVoice.findAll({
      where: { openid: openid },
      order: [['createdAt', 'DESC']]
    });
    res.json({ success: true, list: voices });
  } catch (err) {
    res.status(500).json({ success: false, msg: '查询失败' });
  }
});

const port = process.env.PORT || 80;
app.listen(port, () => {
  console.log('Server running on port', port);
  sequelize.sync(); // 同步数据库表
});
