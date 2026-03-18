const express = require('express');
const axios = require('axios'); 
const { Sequelize, DataTypes } = require('sequelize');

const app = express();

app.use(express.json()); // 解析 JSON 格式的请求体
app.use(express.urlencoded({ extended: false })); // 解析 URL 编码格式

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



// --- 其他功能路由（完整保留） ---
app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body;
  
  if (!openid) return res.status(401).json({ success: false, msg: '未获取到OpenID' });

  try {
    // 1. 尝试查找或创建用户
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: { 
        openid, 
        nickName: nickName || '微信用户', 
        avatarUrl: avatarUrl || '' 
      }
    });

    // 2. 如果不是新创建的，且有新资料传进来，则更新
    if (!created && (nickName || avatarUrl)) {
      if (nickName) user.nickName = nickName;
      if (avatarUrl) user.avatarUrl = avatarUrl;
      await user.save();
    }

    res.json({ success: true, data: user });
  } catch (err) {
    // ⭐ 重要：在日志里打印具体的错误原因（比如：Access denied 或 Connection timeout）
    console.error("数据库操作具体错误:", err); 
    res.status(500).json({ 
      success: false, 
      msg: '数据库错误: ' + err.message 
    });
  }
});

// 将 sync 移到此处，只在启动时运行一次
const port = process.env.PORT || 80;
app.listen(port, async () => {
  console.log('Server running on port', port);
  try {
    await sequelize.authenticate(); // 测试连接是否通畅
    await User.sync({ alter: true }); 
    await UserVoice.sync({ alter: true });
    console.log('数据库连接并同步成功');
  } catch (error) {
    console.error('数据库启动同步失败:', error);
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
