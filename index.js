const express = require('express');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ====================================================
// 1. 阿里云百炼配置（替换成你自己的 API Key）
// 获取地址：https://bailian.console.aliyun.com/ -> API Key 管理
// ====================================================
const ALIYUN_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || 'sk-4c4aefb6e8244b27aa100d8fff592607',
  host:   'https://dashscope.aliyuncs.com',
  model:  'cosyvoice-v3.5-flash'
};

// ====================================================
// 2. 数据库连接
// ====================================================
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

// ====================================================
// 3. 数据库表定义
// ====================================================

// 用户表 —— 与数据库截图中的列完全对齐
const User = sequelize.define('Users', {
  openid:    { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName:  { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' },
  // 截图中 Users 表还有以下三列，保留与数据库一致
  voice_name: { type: DataTypes.STRING, defaultValue: null }, // 下划线命名，与 DB 列名一致
  task_id:    { type: DataTypes.STRING, defaultValue: null },
  speakerId:  { type: DataTypes.STRING, defaultValue: null },
  status:     { type: DataTypes.INTEGER, defaultValue: 0 },
}, {
  tableName:  'Users',
  timestamps: true,
  // 告诉 Sequelize：不要自动把 camelCase 转成下划线，让我们自己控制列名
  underscored: false
});

// 用户音色表 —— 与数据库截图中的列完全对齐
// status: 0=训练中, 1=完成, 2=失败
const UserVoice = sequelize.define('UserVoice', {
  openid:    { type: DataTypes.STRING },
  voiceName: { type: DataTypes.STRING },   // DB列名 voiceName
  speakerId: { type: DataTypes.STRING },   // DB列名 speakerId，存 S_xxxxx
  // taskId 截图里没有单独列，但 status/audioUrl 有，补齐
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },
  audioUrl:  { type: DataTypes.STRING(500), defaultValue: null }, // 截图第6列，存原始音频地址
}, {
  tableName:  'UserVoices',
  timestamps: true,
  underscored: false
});

// ====================================================
// 【新增】音色 Slot 池表
// 说明：你需要提前在火山引擎控制台购买 S_xxxxx 格式的音色 slot
//       然后通过下面的 /admin/add_slots 接口把这些 ID 存进数据库
//       status: 0=未分配, 1=已分配给用户
// ====================================================
const VoiceSlot = sequelize.define('VoiceSlot', {
  speakerId: { type: DataTypes.STRING, allowNull: false, unique: true }, // S_xxxxx
  openid:    { type: DataTypes.STRING, defaultValue: null },             // 分配给哪个用户
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },               // 0=空闲, 1=已用
}, { tableName: 'VoiceSlots', timestamps: true });

// ====================================================
// 4. 路由：登录（保持原有逻辑不变）
// ====================================================
app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body;
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });

  try {
    const [user, created] = await User.findOrCreate({
      where: { openid },
      defaults: { openid, nickName: nickName || '微信用户', avatarUrl: avatarUrl || '' }
    });

    if (!created && (nickName || avatarUrl)) {
      if (nickName) user.nickName = nickName;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
    }
    res.json({ success: true, data: user });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ success: false, msg: '数据库错误: ' + err.message });
  }
});

// ====================================================
// 5. 路由：获取用户音色列表（保持不变）
// ====================================================
app.get('/get_voices', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).send('Unauthorized');
  try {
    const voices = await UserVoice.findAll({
      where: { openid },
      order: [['createdAt', 'DESC']]
    });
    res.json({ success: true, list: voices });
  } catch (err) {
    res.status(500).json({ success: false, msg: '查询失败' });
  }
});

// ====================================================
// 6. 【新增】管理员接口：批量录入从控制台买来的 slot
// 使用方法：用 Postman/curl 调用一次即可，不需要每次调
// 示例请求体：{ "slots": ["S_abc123", "S_def456", "S_ghi789"] }
// ====================================================
app.post('/admin/add_slots', async (req, res) => {
  const { slots } = req.body;
  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ msg: 'slots 必须是数组' });
  }
  try {
    const results = [];
    for (const speakerId of slots) {
      const [slot, created] = await VoiceSlot.findOrCreate({
        where: { speakerId },
        defaults: { speakerId, status: 0 }
      });
      results.push({ speakerId, created });
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error('添加 slot 失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 7. 路由：上传音频并发起克隆训练（核心修复）
// ====================================================
app.post('/start_clone', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, voiceName } = req.body;

  if (!audioUrl || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    // ----------------------------------------
    // 【修复1】从数据库取一个空闲的真实 slot
    // 原来代码是自己造 spk_xxx，火山引擎不认
    // ----------------------------------------
    const slot = await VoiceSlot.findOne({ where: { status: 0 } });
    if (!slot) {
      return res.status(500).json({
        success: false,
        msg: '音色 slot 不足，请管理员在控制台购买更多并录入系统'
      });
    }
    const spk_id = slot.speakerId; // 真实的 S_xxxxx

    // A. 下载音频并转 Base64
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const base64Audio = Buffer.from(audioRes.data).toString('base64');

    // B. 调用火山声音复刻接口
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/mega_tts/audio/upload`,
      {
        appid:      VOLC_CONFIG.appid,
        speaker_id: spk_id,
        audios: [{
          audio_bytes:  base64Audio,
          audio_format: 'mp3'
        }],
        source:     2, // 2=声音复刻
        language:   0, // 0=中文
        model_type: 1  // 1=2.0基础模型
      },
      {
        headers: {
          'Content-Type': 'application/json',
          // ----------------------------------------
          // 【修复2】Bearer 后面必须有空格再加分号
          // 原来写的是 "Bearer;" 少了空格导致鉴权失败
          // ----------------------------------------
          'Authorization': 'Bearer; ' + VOLC_CONFIG.token,
          'Resource-Id':   'volc.megatts.voiceclone'
        }
      }
    );

    // ----------------------------------------
    // 【修复3】正确判断火山引擎的响应格式
    // 原来判断 message === 'Success' 是错的
    // 正确格式是 BaseResp.StatusCode === 0
    // ----------------------------------------
    if (response.data.BaseResp && response.data.BaseResp.StatusCode === 0) {
      // 标记该 slot 已被分配给此用户
      await slot.update({ status: 1, openid });

      // 写入用户音色记录，status=0 表示训练中
      // audioUrl 存原始音频的 HTTP 链接，方便排查问题
      await UserVoice.create({
        openid,
        voiceName: voiceName || '我的音色',
        speakerId: spk_id,
        audioUrl:  audioUrl,
        status: 0
      });

      res.json({ success: true, speakerId: spk_id });
    } else {
      console.error('火山引擎返回错误:', response.data);
      res.status(500).json({
        success: false,
        msg: '火山错误: ' + (response.data.BaseResp?.StatusMessage || '未知错误')
      });
    }

  } catch (err) {
    console.error('start_clone 异常:', err.message);
    res.status(500).json({ success: false, msg: '服务器处理失败: ' + err.message });
  }
});

// ====================================================
// 8. 路由：查询克隆训练状态（阿里云版）
// 阿里云状态：DEPLOYING=训练中, OK=完成, UNDEPLOYED=失败
// ====================================================
app.post('/check_clone_status', async (req, res) => {
  const { speakerId } = req.body;
  if (!speakerId) return res.status(400).json({ success: false, msg: '缺少 speakerId' });

  try {
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:   'query_voice',
          voice_id: speakerId
        }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        }
      }
    );

    const aliyunStatus = response.data.output?.status;
    // 阿里云状态：DEPLOYING=训练中, OK=完成可用, UNDEPLOYED=失败

    if (aliyunStatus === 'OK') {
      await UserVoice.update({ status: 1 }, { where: { speakerId } });
      res.json({ success: true, status: 2 }); // 返回 2 兼容前端轮询逻辑
    } else if (aliyunStatus === 'UNDEPLOYED') {
      await UserVoice.update({ status: 2 }, { where: { speakerId } });
      res.json({ success: true, status: 3 }); // 返回 3 表示失败
    } else {
      res.json({ success: true, status: 1 }); // 返回 1 表示训练中
    }
  } catch (err) {
    console.error('查询状态失败:', err.response?.data || err.message);
    res.status(500).json({ success: false, msg: '查询失败: ' + err.message });
  }
});

// ====================================================
// 9. 【新增】路由：文字合成语音（TTS）
// 用户训练完成后，输入文字，用自己的音色合成语音
// 返回音频的 base64，小程序端再播放
// ====================================================
app.post('/tts', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { text, speakerId } = req.body;

  if (!text || !speakerId) {
    return res.status(400).json({ success: false, msg: '缺少 text 或 speakerId' });
  }

  try {
    const response = await axios.post(
      `${VOLC_CONFIG.host}/api/v1/tts`,
      {
        app: {
          appid:   VOLC_CONFIG.appid,
          token:   VOLC_CONFIG.token,
          cluster: 'volcano_mega' // 使用克隆音色必须用这个 cluster
        },
        user: { uid: openid },
        audio: {
          voice_type:  speakerId, // 填写用户克隆好的 S_xxxxx
          encoding:    'mp3',
          speed_ratio: 1.0,
          volume_ratio: 1.0,
          pitch_ratio:  1.0
        },
        request: {
          reqid:     `req_${Date.now()}`,
          text:      text,
          text_type: 'plain',
          operation: 'query'
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer; ' + VOLC_CONFIG.token
        }
      }
    );

    // 火山返回的是 base64 音频数据
    if (response.data.code === 3000) {
      const audioBase64 = response.data.data;
      res.json({ success: true, audio: audioBase64 }); // 返回 base64
    } else {
      res.status(500).json({
        success: false,
        msg: 'TTS 失败: ' + (response.data.message || '未知错误')
      });
    }
  } catch (err) {
    console.error('TTS 失败:', err.message);
    res.status(500).json({ success: false, msg: 'TTS 请求失败' });
  }
});

// ====================================================
// 10. 路由：重新训练已有音色（阿里云版）
// 阿里云克隆免费，重训就是删除旧音色再新建一个
// ====================================================
app.post('/retrain_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, speakerId } = req.body;

  if (!audioUrl || !speakerId || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    // 校验：只能重训自己的音色
    const voice = await UserVoice.findOne({ where: { speakerId, openid } });
    if (!voice) {
      return res.status(403).json({ success: false, msg: '音色不存在或无权限' });
    }

    // 先删除阿里云旧音色（可选，不删也能用，但会占用配额）
    try {
      await axios.post(
        `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
        { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: speakerId } },
        { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.log('删除旧音色失败（忽略）:', e.message);
    }

    // 重新生成前缀
    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    // 用新音频重新克隆
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          audioUrl,
          prefix:       prefix
        }
      },
      {
        headers: {
          'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey,
          'Content-Type':  'application/json'
        }
      }
    );

    if (response.data.output && response.data.output.voice_id) {
      const newVoiceId = response.data.output.voice_id;
      await voice.update({ speakerId: newVoiceId, audioUrl, status: 0 });
      res.json({ success: true, speakerId: newVoiceId });
    } else {
      res.status(500).json({ success: false, msg: '重训失败: ' + JSON.stringify(response.data) });
    }
  } catch (err) {
    console.error('retrain_voice 异常:', err.response?.data || err.message);
    res.status(500).json({ success: false, msg: err.response?.data?.message || err.message });
  }
});

// ====================================================
// 11. 路由：音色改名
// ====================================================
app.post('/rename_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { id, voiceName } = req.body;
  if (!id || !voiceName) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }
  try {
    const [count] = await UserVoice.update(
      { voiceName },
      { where: { id, openid } }
    );
    if (count === 0) {
      return res.status(404).json({ success: false, msg: '音色不存在或无权限' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('改名失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 12. 启动服务
// ====================================================
const port = process.env.PORT || 80;
app.listen(port, async () => {
  console.log('Server running on port', port);
  // sync() 会自动创建不存在的表（包括新加的 VoiceSlots 表）
  await sequelize.sync();
  console.log('数据库同步完成');
});
