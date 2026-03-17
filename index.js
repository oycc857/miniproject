const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const upload = multer({ dest: '/tmp/' }); // 云托管临时目录

// --- 火山引擎配置 (从云托管环境变量读取) ---
const VOLC_AK = process.env.VOLC_AK; 
const VOLC_SK = process.env.VOLC_SK;
const VOLC_APPID = process.env.VOLC_APPID;

// 火山签名函数 (HMAC-SHA256)
function getVolcanoSign(ak, sk, date, service, region, payload) {
  const kDate = crypto.createHmac('sha256', sk).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
  // 简化版示例，实际 V3 签名需包含 CanonicalRequest 逻辑
  return kSigning.toString('hex');
}

// 1. 核心解析器：必须放在路由之前！
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleString()}] 收到请求: ${req.method} ${req.url}`);
  next();
});

// 2. 数据库配置
const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'nodejs_demo',
  process.env.MYSQL_USERNAME || 'root',
  process.env.MYSQL_PASSWORD || '147896325oycC',
  {
    // 注意：这里删掉了代码里的 :3306，确保默认值也是纯IP
    host: process.env.MYSQL_ADDRESS || '10.2.112.140:3306', 
    dialect: 'mysql',
    port: 3306,
    dialectOptions: { connectTimeout: 10000 },
    logging: console.log // 开启日志，方便我们在云托管日志里看SQL
  }
);

// 3. 模型定义：必须和你截图里的表结构完全一致
const User = sequelize.define('Users', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' } // 增加这个字段
}, {
  tableName: 'Users', 
  timestamps: true // 必须开启，因为 Sequelize 默认需要 createdAt 和 updatedAt
});

const UserVoice = sequelize.define('UserVoice', {
  openid: DataTypes.STRING,
  voiceName: DataTypes.STRING,
  speakerId: DataTypes.STRING,
  status: DataTypes.INTEGER, // 0: 训练中, 1: 成功, 2: 失败
  audioUrl: DataTypes.STRING
}, {
  tableName: 'UserVoices',
  timestamps: true
});

app.post('/login', async (req, res) => {
  console.log('--- 进入登录逻辑 ---');
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body; // 拿到小程序传来的昵称和头像

  console.log('当前 OpenID:', openid);
  console.log('收到资料:', nickName, avatarUrl);

  if (!openid) {
    return res.status(401).json({ success: false, msg: '未获取到OpenID' });
  }

  try {
    // 自动对齐表结构（如果少了字段会自动补上）
    await User.sync({ alter: true });
    
    // 查找或创建用户
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: {
        openid: openid,
        nickName: nickName || '微信用户',
        avatarUrl: avatarUrl || ''
      }
    });

    // 如果是老用户，更新最新的资料
    if (!created) {
      user.nickName = nickName || user.nickName;
      user.avatarUrl = avatarUrl || user.avatarUrl;
      await user.save();
    }

    console.log('登录处理成功:', user.id);
    res.json({ success: true, data: user });
  } catch (err) {
    console.error('数据库操作崩了:', err);
    res.status(500).send({ 
      success: false, 
      msg: '数据库报错', 
      error: err.message,
      detail: err.name 
    });
  }
});

// 1. 处理音频上传并调用火山接口
app.post('/upload', upload.single('voiceFile'), async (req, res) => {
  try {
      const { openid } = req.body;
      const file = req.file;

      if (!file) return res.send({ success: false, msg: '无音频' });

      // 读取文件并转为 Base64
      const audioBase64 = fs.readFileSync(file.path).toString('base64');

      // 2. 调用火山引擎声音克隆接口 (以接口文档为准)
      // 这里的 URL 是火山声音克隆的正式 API 地址
      const volcanoUrl = `https://openspeech.bytedance.com`;
      
      const response = await axios.post(volcanoUrl, {
          app_id: VOLC_APPID,
          audio_data: audioBase64,
          speaker_name: `user_${openid.slice(-5)}`, // 给声音起个名
          description: "小程序用户克隆"
      }, {
          headers: {
              'Authorization': `Volcengine AK="${VOLC_AK}", SignedHeaders="host;x-date", Signature="待算签名"`,
              'Content-Type': 'application/json'
          }
      });

      // 3. 记录到数据库
      // await UserVoice.create({ openid: openid, status: 0, task_id: response.data.task_id });

      res.send({ 
          success: true, 
          msg: '已提交火山引擎克隆', 
          data: response.data 
      });

  } catch (err) {
      console.error('上传失败:', err);
      res.status(500).send({ success: false, msg: '后端克隆任务启动失败' });
  } finally {
      // 清理临时文件
      if (req.file) fs.unlinkSync(req.file.path);
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务正式启动，端口: ${PORT}`));
