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

  // 1. 生成唯一 ID
  const mySpeakerId = `s_${Date.now()}`; 

  try {
    // 2. 调用火山引擎接口
    const response = await axios.post(
      'https://openspeech.bytedance.com/api/v3/tts/voice_clone',
      {
        "speaker_id": mySpeakerId,
        "audio_list": [ // 尝试使用 audio_list 规避 45000000 错误
          {
            "content": audioData, // 使用 content 承载 Base64
            "format": "mp3"
          }
        ],
        "language": 0,
        "model_type": 4 
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-App-Key': '你的APPID', // 注意这里换成你的配置变量
          'X-Api-Access-Key': '你的TOKEN',
          'X-Api-Resource-Id': '你的RESOURCE_ID'
        }
      }
    );

    console.log('火山克隆成功反馈:', response.data);

    // 3. 结果判断
    if (response.data && (response.data.status === 1 || response.data.status === 2)) {
      // 存储到数据库 (确保你之前定义了 UserVoice 模型)
      await UserVoice.create({
        openid: openid,
        voiceName: "我的新音色",
        speakerId: mySpeakerId,
        status: response.data.status 
      });
      res.send({ success: true, speakerId: mySpeakerId });
    } else {
      res.send({ success: false, msg: response.data.message || '克隆状态异常' });
    }

  } catch (err) {
    // 打印详细错误方便在日志里看
    if (err.response) {
      console.error("火山接口具体返回:", JSON.stringify(err.response.data));
    } else {
      console.error("网络或语法错误:", err.message);
    }
    res.status(500).send({ success: false, msg: '服务器内部错误' });
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
