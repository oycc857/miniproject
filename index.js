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
  token: 'caZWuEhKg2TWjHZWXFznm5GPWOr21AqL',
  // 重点：如果长串实例ID报错，请尝试这个固定代号
  resource_id: 'seed-icl-2.0' 
};

app.post('/upload-base64', async (req, res) => {
  const { audioData } = req.body;
  const openid = req.headers['x-wx-openid'] || "user_default";

  // 1. 生成一个本次克隆的唯一 ID (格式要求：S_加上你的自定义后缀)
  // 注意：这个 ID 建议从你的数据库取，或者用时间戳生成，不能重复
  const mySpeakerId = `S_${Date.now()}`; 

  try {
    const response = await axios.post(
      'https://openspeech.bytedance.com/api/v3/tts/voice_clone', // ⭐ 必须是这个 URL
      {
        "speaker_id": mySpeakerId, // ⭐ 必须传一个你定义的 ID
        "audios": {
          "data": audioData,       // Base64 数据
          "format": "mp3"          // 对应你小程序的录音格式
        },
        "language": 0,             // 0 代表中文
        "model_types": [4]         // 4 代表你要的 ICL 2.0 效果
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-App-Key': VOLC_CONFIG.appid,    // ⭐ 文档要求是 App-Key
          'X-Api-Access-Key': VOLC_CONFIG.token, // 你的 Access Token
          'X-Api-Resource-Id': VOLC_CONFIG.resource_id // 你的实例 ID
        }
      }
    );

    console.log('火山引擎克隆返回:', JSON.stringify(response.data));

    // 状态码 2 代表训练成功，4 代表已激活
    if (response.data.status === 2 || response.data.status === 4) {
       // 存储到数据库
       await UserVoice.create({
         openid: openid,
         voiceName: "我的新声音",
         speakerId: mySpeakerId, // 以后合成就用这个 ID
         status: 1
       });
       res.send({ success: true, speakerId: mySpeakerId });
    } else {
       res.send({ success: false, msg: response.data.message || '克隆中或排队中', code: response.data.status });
    }
  } catch (err) {
    if (err.response) {
      console.error("报错详情:", JSON.stringify(err.response.data));
    }
    res.status(500).send({ success: false, msg: '克隆请求失败' });
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
