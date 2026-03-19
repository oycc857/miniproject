const express = require('express');
const axios = require('axios'); 
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

app.use(express.json()); // 解析 JSON 格式的请求体
app.use(express.urlencoded({ extended: false })); // 解析 URL 编码格式

// 1--- 火山引擎配置 (请替换为你自己的) ---
const VOLC_CONFIG = {
  appid: '4870175430',
  token: 'M-4FC8-xLI8dfRwC3MLSibGCg58TVedJ',
  license: '4870175430',
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
// --- 调试日志：如果报错，请去云托管控制台看这里的打印 ---
console.log('[收到请求] Body:', req.body);
console.log('[收到请求] Headers中的OpenID:', openid);
if (!openid) {
  return res.status(400).json({ 
    success: false, 
    msg: '参数不全: 未获取到微信身份(openid)，请检查是否通过云托管正常调用' 
  });
}
if (!audioUrl) {
  return res.status(400).json({ 
    success: false, 
    msg: '参数不全: 缺少音频下载链接(audioUrl)' 
  });
}
  // 在 Mega-TTS 中，你可以为用户生成一个唯一的 speaker_id
  const spk_id = `spk_${openid.substring(0, 8)}_${Date.now()}`;

  try {
    // 1. 下载音频转为 Base64（对应官方 Python 逻辑）
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const base64Audio = Buffer.from(audioRes.data).toString('base64');
    const audioFormat = audioUrl.split('.').pop().split('?')[0] || 'mp3';

    // 2. 调用火山引擎 Mega-TTS 接口
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/mega_tts/audio/upload`,
      {
        appid: VOLC_CONFIG.appid,
        speaker_id: spk_id,
        license: VOLC_CONFIG.license, // 👈 传给 body 里的这个字段
        audios: [{
          audio_bytes: base64Audio,
          audio_format: audioFormat
        }],
        source: 2,
        language: 0,
        model_type: 1
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer;" + VOLC_CONFIG.token,
          "Resource-Id": "volc.megatts.voiceclone"
        }
      }
    );

    if (response.status === 200) {
      // 5. 写入数据库，记录 speakerId 以便后续查询状态
      await UserVoice.create({
        openid,
        voiceName: voiceName || 'AI分身',
        speakerId: spk_id,
        status: 0
      });

      res.json({ success: true, speakerId: spk_id });
    } else {
      throw new Error(`火山接口返回状态码: ${response.status}`);
    }

  } catch (err) {
    console.error("Mega-TTS 训练请求失败:", err.response?.data || err.message);
    res.status(500).json({ 
      success: false, 
      msg: '训练请求失败', 
      detail: err.response?.data || err.message 
    });
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
