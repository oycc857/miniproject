const express = require('express');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');
const OSS = require('ali-oss');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const path = require('path');
app.use('/static', express.static(path.join(__dirname, 'static')));

const WebSocket = require('ws');

// ====================================================
// WebSocket TTS Helper（cosyvoice-v3.5 系列专用）
// ====================================================
function ttsWithWebSocket(text, voiceId) {
  return new Promise((resolve, reject) => {
    const url = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    const ws = new WebSocket(url, {
      headers: { 'Authorization': 'bearer ' + ALIYUN_CONFIG.apiKey }
    });

    const chunks = [];
    let taskStarted = false;
    const taskId = 'task_' + Date.now();

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task:       'tts',
          function:   'SpeechSynthesizer',
          model:      'cosyvoice-v3.5-flash',
          parameters: { voice: voiceId, format: 'mp3', sample_rate: 22050 },
          input:      {}
        }
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) { chunks.push(Buffer.from(data)); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      const event = msg.header?.event;
      if (event === 'task-started') {
        taskStarted = true;
        ws.send(JSON.stringify({
          header:  { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: { text: text } }
        }));
        ws.send(JSON.stringify({
          header:  { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} }
        }));
      } else if (event === 'task-finished') {
        ws.close();
        resolve(Buffer.concat(chunks));
      } else if (event === 'task-failed') {
        ws.close();
        reject(new Error(msg.header?.error_message || '合成失败'));
      }
    });

    ws.on('error', (err) => reject(err));
    ws.on('close', () => {
      if (chunks.length > 0 && !taskStarted) resolve(Buffer.concat(chunks));
    });

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      if (chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error('WebSocket TTS 超时'));
    }, 30000);
  });
}

const ossClient = new OSS({
  region:          process.env.OSS_REGION,
  accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket:          process.env.OSS_BUCKET
});

const ALIYUN_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY,
  host:   'https://dashscope.aliyuncs.com',
  model:  'cosyvoice-v3.5-flash'
};

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
// 数据库表定义
// ====================================================
const User = sequelize.define('Users', {
  openid:            { type: DataTypes.STRING,  allowNull: false, unique: true },
  nickName:          { type: DataTypes.STRING,  defaultValue: '微信用户' },
  avatarUrl:         { type: DataTypes.STRING,  defaultValue: '' },
  // ── 免费配额（每日重置）──
  free_chars_used:   { type: DataTypes.INTEGER, defaultValue: 0 },
  free_private_used: { type: DataTypes.INTEGER, defaultValue: 0 },
  free_clone_used:   { type: DataTypes.INTEGER, defaultValue: 0 },
  last_reset_date:   { type: DataTypes.DATEONLY, defaultValue: null },
}, { tableName: 'Users', timestamps: true, underscored: false });

// ====================================================
// 每日免费配额
// ====================================================
const BILLING = {
  FREE_PUBLIC_CHARS:  100,  // 每日免费公共字符
  FREE_PRIVATE_CHARS: 30,   // 每日免费私人字符
  FREE_CLONE_TIMES:   1,    // 每日免费克隆次数
};

// 检查是否需要重置（每天0点刷新）
async function resetIfNewDay(user) {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const lastReset = user.last_reset_date
    ? (typeof user.last_reset_date === 'string' ? user.last_reset_date : new Date(user.last_reset_date).toISOString().slice(0, 10))
    : null;
  if (lastReset !== today) {
    await user.update({
      free_chars_used:   0,
      free_private_used: 0,
      free_clone_used:   0,
      last_reset_date:   today,
    });
    await user.reload();
  }
}

// 检查并扣除字符（仅免费额度，每日刷新）
async function chargeChars(user, charCount, isPrivate) {
  await resetIfNewDay(user);

  if (isPrivate) {
    if (user.free_private_used + charCount <= BILLING.FREE_PRIVATE_CHARS) {
      await user.increment('free_private_used', { by: charCount });
      return { ok: true };
    }
    const remaining = Math.max(0, BILLING.FREE_PRIVATE_CHARS - user.free_private_used);
    return { ok: false, msg: `今日免费私人字符已用完（剩余 ${remaining} 字），明天再来吧` };
  } else {
    if (user.free_chars_used + charCount <= BILLING.FREE_PUBLIC_CHARS) {
      await user.increment('free_chars_used', { by: charCount });
      return { ok: true };
    }
    const remaining = Math.max(0, BILLING.FREE_PUBLIC_CHARS - user.free_chars_used);
    return { ok: false, msg: `今日免费公共字符已用完（剩余 ${remaining} 字），明天再来吧` };
  }
}

// 检查并扣除克隆次数（仅免费额度，每日刷新）
async function chargeClone(user) {
  await resetIfNewDay(user);

  if (user.free_clone_used < BILLING.FREE_CLONE_TIMES) {
    await user.increment('free_clone_used', { by: 1 });
    return { ok: true };
  }
  return { ok: false, msg: `今日免费克隆次数已用完，明天再来吧` };
}

// 获取用户余额概况
async function getUserBalance(user) {
  await resetIfNewDay(user);
  return {
    hasSubscribe:    false,
    subscribeExpire: null,
    freeCharsLeft:   Math.max(0, BILLING.FREE_PUBLIC_CHARS  - user.free_chars_used),
    freePrivateLeft: Math.max(0, BILLING.FREE_PRIVATE_CHARS - user.free_private_used),
    freeCloneLeft:   Math.max(0, BILLING.FREE_CLONE_TIMES   - user.free_clone_used),
    paidChars:       0,
    paidClone:       0,
  };
}

const UserVoice = sequelize.define('UserVoice', {
  openid:    { type: DataTypes.STRING },
  voiceName: { type: DataTypes.STRING },
  speakerId: { type: DataTypes.STRING },
  status:    { type: DataTypes.INTEGER, defaultValue: 0 },
  audioUrl:  { type: DataTypes.STRING(500), defaultValue: null },
}, { tableName: 'UserVoices', timestamps: true, underscored: false });

// ====================================================
// 登录
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
// 获取用户音色列表
// ====================================================
app.get('/get_voices', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).send('Unauthorized');
  try {
    const voices = await UserVoice.findAll({
      where: { openid },
      order: [['id', 'DESC']]
    });
    res.json({ success: true, list: voices });
  } catch (err) {
    console.error('get_voices 失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 上传音频并发起克隆训练
// ====================================================
app.post('/start_clone', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, voiceName } = req.body;

  if (!audioUrl || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  let ossKey = null;

  try {
    const user = await User.findOne({ where: { openid } });
    if (!user) return res.status(401).json({ success: false, msg: '用户不存在' });

    const cloneCheck = await chargeClone(user);
    if (!cloneCheck.ok) {
      return res.status(403).json({ success: false, msg: cloneCheck.msg, code: 'NO_CLONE_QUOTA' });
    }

    const existingVoice = await UserVoice.findOne({ where: { openid, status: 0 } });
    if (existingVoice) {
      // 退还刚扣的克隆次数
      await user.decrement('free_clone_used', { by: 1 });
      return res.status(400).json({
        success: false,
        msg: '你有一个音色正在训练中，请等待完成后再提交'
      });
    }

    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioRes.data);

    ossKey = `temp_voices/${openid.slice(-6)}_${Date.now()}.mp3`;
    await ossClient.put(ossKey, audioBuffer, { headers: { 'x-oss-object-acl': 'public-read' } });
    const ossUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey}`;

    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: {
          action:       'create_voice',
          target_model: ALIYUN_CONFIG.model,
          url:          ossUrl,
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
      const voiceId = response.data.output.voice_id;
      await UserVoice.create({
        openid,
        voiceName: voiceName || '我的音色',
        speakerId: voiceId,
        audioUrl:  ossUrl,
        status: 0
      });
      res.json({ success: true, speakerId: voiceId });
    } else {
      ossClient.delete(ossKey).catch(() => {});
      console.error('阿里云返回错误:', JSON.stringify(response.data));
      res.status(500).json({
        success: false,
        msg: '克隆失败: ' + (response.data.message || JSON.stringify(response.data))
      });
    }
  } catch (err) {
    if (ossKey) ossClient.delete(ossKey).catch(() => {});
    console.error('start_clone 异常:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      msg: err.response?.data?.message || err.message
    });
  }
});

// ====================================================
// 查询克隆训练状态
// ====================================================
app.post('/check_clone_status', async (req, res) => {
  const { speakerId } = req.body;
  if (!speakerId) return res.status(400).json({ success: false, msg: '缺少 speakerId' });

  try {
    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: speakerId } },
      { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
    );

    const output = response.data.output || {};
    const aliyunStatus = output.status;
    console.log('【查询状态】阿里云返回:', JSON.stringify(response.data));

    if (aliyunStatus === 'OK') {
      await UserVoice.update({ status: 1 }, { where: { speakerId } });
      res.json({ success: true, status: 2 });
    } else if (aliyunStatus === 'UNDEPLOYED' || aliyunStatus === 'FAILED') {
      await UserVoice.update({ status: 2 }, { where: { speakerId } });
      res.json({ success: true, status: 3 });
    } else {
      res.json({ success: true, status: 1 });
    }
  } catch (err) {
    const errData = err.response?.data;
    const errCode = errData?.code || '';
    console.error('查询状态失败:', errData || err.message);
    if (errCode === 'BadRequest.ResourceNotExist') {
      return res.json({ success: true, status: 1 });
    }
    res.status(500).json({ success: false, msg: '查询失败: ' + err.message });
  }
});

// ====================================================
// 重新训练已有音色
// ====================================================
app.post('/retrain_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { audioUrl, speakerId } = req.body;

  if (!audioUrl || !speakerId || !openid) {
    return res.status(400).json({ success: false, msg: '参数不足' });
  }

  try {
    const voice = await UserVoice.findOne({ where: { speakerId } });
    if (!voice) return res.status(403).json({ success: false, msg: '音色不存在' });

    try {
      await axios.post(
        `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
        { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: speakerId } },
        { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
      );
    } catch (e) { console.log('删除旧音色失败（忽略）:', e.message); }

    const prefix = 'u' + openid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

    const audioRes2 = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const ossKey2 = `temp_voices/retrain_${openid.slice(-6)}_${Date.now()}.mp3`;
    await ossClient.put(ossKey2, Buffer.from(audioRes2.data), { headers: { 'x-oss-object-acl': 'public-read' } });
    const ossUrl2 = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey2}`;

    const response = await axios.post(
      `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
      {
        model: 'voice-enrollment',
        input: { action: 'create_voice', target_model: ALIYUN_CONFIG.model, url: ossUrl2, prefix }
      },
      { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
    );

    if (response.data.output && response.data.output.voice_id) {
      const newVoiceId = response.data.output.voice_id;
      await voice.update({ speakerId: newVoiceId, audioUrl: ossUrl2, status: 0 });
      res.json({ success: true, speakerId: newVoiceId });
    } else {
      ossClient.delete(ossKey2).catch(() => {});
      res.status(500).json({ success: false, msg: '重训失败: ' + JSON.stringify(response.data) });
    }
  } catch (err) {
    console.error('retrain_voice 异常:', err.response?.data || err.message);
    res.status(500).json({ success: false, msg: err.response?.data?.message || err.message });
  }
});

// ====================================================
// 音色改名
// ====================================================
app.post('/rename_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { id, voiceName } = req.body;
  if (!id || !voiceName) return res.status(400).json({ success: false, msg: '参数不足' });
  try {
    const [count] = await UserVoice.update({ voiceName }, { where: { id, openid } });
    if (count === 0) return res.status(404).json({ success: false, msg: '音色不存在或无权限' });
    res.json({ success: true });
  } catch (err) {
    console.error('改名失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 私人音色 TTS 合成
// ====================================================
app.post('/tts_private', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { text, speakerId } = req.body;

  if (!text || !speakerId) return res.status(400).json({ success: false, msg: '参数不足' });

  try {
    const voice = await UserVoice.findOne({ where: { speakerId } });
    if (!voice) return res.status(403).json({ success: false, msg: '音色不存在' });

    const user = await User.findOne({ where: { openid } });
    if (!user) return res.status(401).json({ success: false, msg: '用户不存在' });

    const charCheck = await chargeChars(user, text.length, true);
    if (!charCheck.ok) {
      return res.status(403).json({ success: false, msg: charCheck.msg, code: 'NO_CHARS' });
    }

    const audioBuffer = await ttsWithWebSocket(text, speakerId);
    res.json({ success: true, audio: audioBuffer.toString('base64') });

  } catch (err) {
    console.error('【私人TTS】异常:', err.message);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 删除音色
// ====================================================
app.post('/delete_voice', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { id, speakerId } = req.body;
  if (!id) return res.status(400).json({ success: false, msg: '参数不足' });
  try {
    if (speakerId) {
      axios.post(
        `${ALIYUN_CONFIG.host}/api/v1/services/audio/tts/customization`,
        { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: speakerId } },
        { headers: { 'Authorization': 'Bearer ' + ALIYUN_CONFIG.apiKey, 'Content-Type': 'application/json' } }
      ).catch(() => {});
    }
    const voice = await UserVoice.findOne({ where: { id, openid } });
    if (voice && voice.audioUrl) {
      const key = voice.audioUrl.replace(/^https?:\/\/[^/]+\//, '');
      ossClient.delete(key).catch(() => {});
    }
    await UserVoice.destroy({ where: { id, openid } });
    res.json({ success: true });
  } catch (err) {
    console.error('删除音色失败:', err);
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 查询用户余额（含每日重置）
// ====================================================
app.get('/get_balance', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });
  try {
    const user = await User.findOne({ where: { openid } });
    if (!user) return res.status(404).json({ success: false, msg: '用户不存在' });
    const balance = await getUserBalance(user);
    res.json({ success: true, balance });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 公共音色 TTS 扣费
// ====================================================
app.post('/charge_public_tts', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { charCount } = req.body;
  if (!openid || !charCount) return res.status(400).json({ success: false, msg: '参数不足' });
  try {
    const user = await User.findOne({ where: { openid } });
    if (!user) return res.status(401).json({ success: false, msg: '用户不存在' });
    const result = await chargeChars(user, charCount, false);
    if (!result.ok) return res.status(403).json({ success: false, msg: result.msg, code: 'NO_CHARS' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 强制标记音色训练完成
// ====================================================
app.post('/force_complete', async (req, res) => {
  const { speakerId } = req.body;
  if (!speakerId) return res.status(400).json({ success: false });
  try {
    await UserVoice.update({ status: 1 }, { where: { speakerId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ====================================================
// 启动服务：先同步数据库，再开始监听，避免新列不存在时请求进来报错
// ====================================================
const port = process.env.PORT || 80;

(async () => {
  try {
    await sequelize.sync({ alter: true });
    console.log('数据库同步完成');
  } catch (err) {
    console.error('数据库同步失败:', err.message);
  }
  app.listen(port, () => {
    console.log('Server running on port', port);
  });
})();
