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
// 这里的配置请严格对照你的控制台
const VOLC_CONFIG = {
  appid: '2480093223',
  token: 'f5ddfac5-3690-4dca-a009-7896797bafa6',
  // 重点：如果长串实例ID报错，请尝试这个固定代号
  resource_id: 'seed-icl-2.0' 
};

app.post('/upload-base64', async (req, res) => {
  const { audioData, openid } = req.body;

  try {
    const response = await axios.post(
      'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      {
        app: {
          appid: VOLC_CONFIG.appid,
          token: VOLC_CONFIG.token,
          cluster: "volcano_icl" // 2.0复刻固定集群
        },
        user: { uid: openid || "user_1" },
        audio: { format: "mp3", sample_rate: 16000 },
        request: {
          column: 1,
          text: "这里填一段话，火山会用你克隆出的声音把这段话读出来", 
          speaker: "icl_default", // 第一次复刻填这个，它会自动生成新音色
          voice_type: "icl",
          editing: {
            audio_data: audioData // 这就是你的“上传”动作，直接传base64
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-App-Id': VOLC_CONFIG.appid,
          'X-Api-Access-Key': VOLC_CONFIG.token,
          'X-Api-Resource-Id': VOLC_CONFIG.resource_id
        }
      }
    );

    // 如果成功，火山会返回 addition.speaker_id
    if (response.data.addition && response.data.addition.speaker_id) {
       const newSpeakerId = response.data.addition.speaker_id;
       // 把这个 newSpeakerId 存入你的数据库，以后用这个声音就靠它了
       res.send({ success: true, speakerId: newSpeakerId });
    } else {
       res.send({ success: false, msg: response.data.message });
    }
  } catch (err) {
    res.status(500).send({ success: false, msg: '调用失败' });
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
