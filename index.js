const express = require('express');
const axios = require('axios'); 
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

app.use(express.json()); // 解析 JSON 格式的请求体
app.use(express.urlencoded({ extended: false })); // 解析 URL 编码格式

// 1--- 火山引擎配置 (请替换为你自己的) ---
const VOLC_CONFIG = {
  appid: '2480093223',
  token: 'caZWuEhKg2TWjHZWXFznm5GPWOr21AqL',
  license: '2480093223',
  host: 'https://openspeech.bytedance.com'
};

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
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' },
  speakerId: DataTypes.STRING, // Mega-TTS 中由你指定或返回的 ID
  status: { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'Users', timestamps: true });

const UserVoice = sequelize.define('UserVoice', {
  openid: DataTypes.STRING,
  voiceName: DataTypes.STRING,
  speakerId: DataTypes.STRING, 
  taskId: DataTypes.STRING,    
  status: { type: DataTypes.INTEGER, defaultValue: 0 }, 
}, { tableName: 'UserVoices', timestamps: true });

// --- 【核心逻辑】上传并训练 ---
app.post('/start_clone', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, voiceName } = req.body;

  if (!audioUrl || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  // 生成唯一的音色 ID
  const spk_id = `spk_${openid.slice(-6)}_${Date.now()}`;

  try {
    // A. 下载音频并转 Base64
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const base64Audio = Buffer.from(audioRes.data).toString('base64');

    // B. 调用火山 V3 声音复刻接口
    // 注意：Resource-Id 在 V3 2.0 中非常关键
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/mega_tts/audio/upload`,
      {
        appid: VOLC_CONFIG.appid,
        speaker_id: spk_id,
        license: VOLC_CONFIG.license,
        audios: [{
          audio_bytes: base64Audio,
          audio_format: 'mp3'
        }],
        source: 2,    // 2 表示声音复刻
        language: 0,  // 0 表示中文
        model_type: 1 // 1 表示基础模型 (2.0)
      },
      {
        headers: {
          "Content-Type": "application/json",
          // V3 标准 Authorization 格式：Bearer后面接空格
          "Authorization": `Bearer ${VOLC_CONFIG.token}`,
          "Resource-Id": "volc.megatts.voiceclone"
        }
      }
    );

    // C. 处理结果
    if (response.data.message === 'Success' || response.data.code === 0) {
      // 写入数据库
      await UserVoice.create({
        openid: openid,
        voiceName: voiceName || '我的音色',
        speakerId: spk_id,
        status: 0 // 0: 训练中
      });
      res.json({ success: true, speakerId: spk_id });
    } else {
      console.error("火山返回错误:", response.data);
      res.status(500).json({ 
        success: false, 
        msg: `火山错误: ${response.data.message || '未知错误'}` 
      });
    }
  } catch (err) {
    console.error("后端处理失败:", err.message);
    res.status(500).json({ success: false, msg: '服务器训练请求失败' });
  }
});

// --- 其他功能路由（完整保留） ---
app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body;
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });

  try {
    // 关键：不要在这里写 User.sync({ alter: true })，它太重了且容易导致 500
    
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: { 
        openid, 
        nickName: nickName || '微信用户', 
        avatarUrl: avatarUrl || '' 
      }
    });

    if (!created && (nickName || avatarUrl)) {
      if (nickName) user.nickName = nickName;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
    }
    res.json({ success: true, data: user });
  } catch (err) {
    // ⭐ 必须在控制台打印 err，否则你永远不知道是密码错了还是字段满了
    console.error("数据库操作失败详情:", err); 
    res.status(500).json({ success: false, msg: '数据库错误: ' + err.message });
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
