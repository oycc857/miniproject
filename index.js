const express = require('express');
const { Service } = require('@volcengine/openapi');
const axios = require('axios'); 
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

// 1. 必须：调大体积限制，防止 Base64 导致 413 错误或 102002 超时
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: false, limit: '40mb' }));

// 2. 数据库连接（保持你原有的配置）
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

// --- 模型定义（保持不变） ---
const User = sequelize.define('Users', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' }
}, { tableName: 'Users', timestamps: true });

const UserVoice = sequelize.define('UserVoice', {
  openid: DataTypes.STRING,
  voiceName: DataTypes.STRING,
  speakerId: DataTypes.STRING, 
  taskId: DataTypes.STRING,    
  status: { type: DataTypes.INTEGER, defaultValue: 0 }, 
}, { tableName: 'UserVoices', timestamps: true });

// --- 核心修复：上传并克隆接口 ---
app.post('/upload-base64', async (req, res) => {
  const { audioData, openid } = req.body;
  if (!audioData) return res.status(400).send({ success: false, msg: '缺少音频数据' });

  try {
    const requestBody = {
      Action: 'CreateTtsCustomizationSpeaker',
      Version: '2023-11-01',
      Appid: process.env.VOLC_APPID,
      ServiceId: process.env.VOLC_SERVICE_ID,
      SpeakerName: `user_${openid ? openid.slice(-5) : 'test'}`,
      AudioFormat: 'mp3',
      SampleRate: 16000,
      AudioData: audioData 
    };

    // --- 万能修复：直接使用 axios 发送 POST 请求给火山，不再调用不存在的 vcllClient.request ---
  const volcResponse = await axios.post('https://openspeech.bytedance.com/api/v1/tts_customization', requestBody, {
      headers: {
        'Content-Type': 'application/json',
        // 关键：火山接口需要通过 Header 传递 Action
        'Resource-Id': 'volc.openapi.v3', 
        'X-Action': 'CreateTtsCustomizationSpeaker',
        'X-Version': '2023-11-01'
      },
      timeout: 30000 
    });

    const result = volcResponse.data;
    console.log('火山返回原始结果:', result);

    if (result.Data && result.Data.SpeakerId) {
      // 成功后存入数据库
      await UserVoice.create({
        openid: openid,
        speakerId: result.Data.SpeakerId,
        status: 0
      });
      res.send({ success: true, speakerId: result.Data.SpeakerId });
    } else {
      res.send({ 
        success: false, 
        msg: result.ResponseMetadata?.Error?.Message || '火山接口返回错误' 
      });
    }
  } catch (err) {
    console.error('调用火山报错详情:', err.response ? err.response.data : err.message);
    res.status(500).send({ 
      success: false, 
      msg: '后端转发失败: ' + (err.response?.data?.ResponseMetadata?.Error?.Message || err.message) 
    });
  }
});

// --- 其他功能路由（完整保留） ---
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
    if (!created && (nickName || avatarUrl)) {
      if (nickName) user.nickName = nickName;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
    }
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, msg: '数据库错误' });
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
  sequelize.sync(); 
});
