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
  // 云托管会自动在 header 里带上 openid
  const openid = req.headers['x-wx-openid']; 
  const { nickName, avatarUrl } = req.body; // 接收前端传来的资料

  try {
    // findOrCreate: 如果找不到就新建，找到了就返回
    const [user, created] = await User.findOrCreate({
      where: { openid: openid },
      defaults: {
        openid: openid,
        nickName: nickName || '微信用户',
        avatarUrl: avatarUrl || ''
      }
    });

    // 如果用户已存在但资料变了，可以更新一下
    if (!created && nickName) {
      user.nickName = nickName;
      user.avatarUrl = avatarUrl;
      await user.save();
    }

    res.send({ success: true, data: user });
  } catch (err) {
    res.status(500).send({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务正式启动，端口: ${PORT}`));
