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
// --- 核心修复：V3 声音复刻接口 ---
app.post('/upload-base64', async (req, res) => {
  const { audioData, openid } = req.body;
  if (!audioData) return res.status(400).send({ success: false, msg: '音频为空' });

  try {
    // 根据你提供的文档，声音复刻 2.0 字符版资源 ID 为 seed-icl-2.0
    // 请求路径为 api/v3/tts/unidirectional
    const url = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

    // 构造 V3 协议要求的请求体
    const requestData = {
      app: {
        appid: process.env.VOLC_APPID,
        token: process.env.VOLC_AK, // 此处对应 X-Api-Access-Key
        cluster: "volcano_icl" // 声音复刻通常固定为此集群名，请根据控制台确认
      },
      user: {
        uid: openid || "guest_user"
      },
      audio: {
        format: "mp3",
        sample_rate: 16000
      },
      // 声音复刻的关键参数：提供参考音频
      request: {
        column: 1,
        text: "这是用于声音复刻训练的示例文本", // 某些版本需要一段文本触发
        speaker: "icl_default", 
        voice_type: "icl",
        // 将你的参考音频 Base64 放入
        editing: {
          audio_data: audioData 
        }
      }
    };

    const response = await axios.post(url, requestData, {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': process.env.VOLC_APPID,
        'X-Api-Access-Key': process.env.VOLC_AK,
        'X-Api-Resource-Id': 'TTS-SeedICL2.02000000652173615426' // 声音复刻 2.0 资源 ID
      },
      timeout: 60000
    });

    console.log('火山 V3 返回:', response.data);

    // V3 接口返回结果通常在 addition 或是 data 字段中
    if (response.data && response.data.addition && response.data.addition.speaker_id) {
      const speakerId = response.data.addition.speaker_id;
      
      await UserVoice.create({
        openid: openid,
        speakerId: speakerId,
        status: 0
      });

      res.send({ success: true, speakerId: speakerId });
    } else {
      res.send({ 
        success: false, 
        msg: response.data.message || '复刻请求未生成 SpeakerId' 
      });
    }

  } catch (err) {
    const errInfo = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('V3接口调用失败:', errInfo);
    res.status(500).send({ success: false, msg: '火山V3接口报错', debug: errInfo });
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
