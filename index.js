const express = require('express');
const multer = require('multer');
const { Service } = require('volc-sdk-nodejs'); 
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const upload = multer({ dest: '/tmp/' });

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
const vcllClient = new Service({
    host: 'openspeech.bytedance.com',
    region: 'cn-north-1',
    accessKeyId: process.env.VOLC_AK,
    secretAccessKey: process.env.VOLC_SK,
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
app.post('/upload', upload.single('voiceFile'), async (req, res) => {
  // 优先从 header 获取微信 OpenID
  const openid = req.headers['x-wx-openid'] || req.body.openid;
  const file = req.file;

  if (!file || !openid) return res.status(400).send({ success: false, msg: '参数不足' });

  try {
    const audioBase64 = fs.readFileSync(file.path).toString('base64');

    // --- 核心修改：匹配官方文档 2227958 的参数 ---
    const params = {
      // 公共参数
      Action: 'CreateTtsCustomizationSpeaker', // 极速克隆的 Action 名称
      Version: '2023-11-01',
      
      // 业务参数
      Appid: process.env.VOLC_APPID,
      ServiceId: process.env.VOLC_SERVICE_ID, // 必须填这个，文档要求的
      SpeakerName: `user_${openid.slice(-5)}`,
      Description: "小程序用户声音克隆",
      
      // 音频数据
      AudioData: audioBase64,
      // 根据文档，通常需要指定音频格式，默认常用 mp3 或 wav
      AudioFormat: 'mp3', 
      // 采样率建议与你小程序录音设置的一致（比如 16000）
      SampleRate: 16000 
    };

    // 使用 SDK 发起请求
    // 注意：vcllClient 需要在初始化时指定 host 为 'openspeech.bytedance.com'
    const result = await vcllClient.request('CreateTtsCustomizationSpeaker', params);

    // 记录到数据库
    await UserVoice.sync();
    await UserVoice.create({ 
        openid: openid, 
        voiceName: '我的克隆声音',
        // 文档返回的通常是 SpeakerId 或 TaskId
        speakerId: result.Data.SpeakerId || '', 
        status: 0 // 0 表示正在训练/同步
    });

    res.send({ 
        success: true, 
        msg: '提交成功，正在生成 AI 声音', 
        data: result.Data 
    });

  } catch (err) {
    console.error('火山克隆接口调用失败:', err);
    res.status(500).send({ 
        success: false, 
        msg: '接口调用失败', 
        error: err.message 
    });
  } finally {
    if (file) fs.unlinkSync(file.path);
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

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务运行在端口: ${PORT}`));
