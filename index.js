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
  console.log('--- 进入登录逻辑 ---');
  const openid = req.headers['x-wx-openid'];
  console.log('当前 OpenID:', openid);

  if (!openid) {
    return res.status(401).json({ success: false, msg: '未获取到OpenID' });
  }

  try {
    console.log('正在尝试连接数据库并同步表...');
    await sequelize.authenticate(); // 测试连接
    await User.sync();             // 同步表
    
    const [user, created] = await User.findOrCreate({
      where: { openid: openid }
    });

    console.log('登录处理成功:', user.id);
    res.json({ success: true, data: user });
  } catch (err) {
    console.error('数据库操作崩了:', err);
    // 这里把错误发回给小程序，方便你直接在手机/开发者工具上看到原因
    res.status(500).send({ success: false, msg: '数据库报错', error: err.message });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务正式启动，端口: ${PORT}`));
