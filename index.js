const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const app = express();
app.use(express.json());

// 增加打印：确认服务收到请求
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleString()}] 收到请求: ${req.method} ${req.url}`);
  next();
});

const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'nodejs_demo',
  process.env.MYSQL_USERNAME || 'root',
  process.env.MYSQL_PASSWORD || '147896325oycC',
  {
    host: process.env.MYSQL_ADDRESS ||  '10.2.112.140:3306', 
    dialect: 'mysql',
    port: 3306,
    // 关键：缩短超时时间，防止无限卡死
    dialectOptions: { connectTimeout: 10000 } 
  }
);

const User = sequelize.define('User', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' }
});

app.post('/login', async (req, res) => {
  const openid = req.headers['x-wx-openid'];
  const { nickName, avatarUrl } = req.body; // 拿到小程序传来的昵称头像

  try {
    // 自动寻找或创建用户
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: {
        openid: openid,
        nickName: nickName || '微信用户',
        avatarUrl: avatarUrl || ''
      }
    });

    // 如果是老用户，更新一下最新的昵称和头像
    if (!created) {
      user.nickName = nickName;
      user.avatarUrl = avatarUrl;
      await user.save();
    }

    res.send({ success: true, data: user });
  } catch (err) {
    console.error('数据库操作失败:', err);
    res.status(500).send({ success: false, msg: '数据库报错', error: err.message });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务正式启动，端口: ${PORT}`));
