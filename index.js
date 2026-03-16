const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const app = express();
app.use(express.json());

// 1. 连接数据库 (云托管会自动注入这些环境变量)
const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE || 'nodejs_demo', // 数据库名
  process.env.MYSQL_USERNAME || 'root',    // 用户名
  process.env.MYSQL_PASSWORD || '147896325oycC',        // 密码
  {
    host: 'cloud1-3gy4mj7v0c84bdb8' || 'localhost', 
    dialect: 'mysql',
    port: 3306,
    logging: false, // 生产环境关闭日志，保持整洁
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    dialectOptions: {
      // 部分云托管版本需要这个来确保连接稳定性
      connectTimeout: 60000
    }
  }
);
// 测试连接是否成功
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功！');
    // 同步模型（如果表不存在会自动创建）
    await sequelize.sync({ alter: true }); 
    console.log('✅ 用户表同步完成！');
  } catch (error) {
    console.error('❌ 无法连接到数据库:', error);
  }
}
// 2. 定义用户模型
const User = sequelize.define('User', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' }
});

// 3. 登录接口
app.post('/login', async (req, res) => {
  // 云托管核心：从 header 直接获取 openid
  const openid = req.headers['x-wx-openid'];
  
  if (!openid) {
    return res.status(401).send({ success: false, msg: '未获取到身份信息' });
  }

  try {
    await sequelize.sync(); // 自动创建表
    const [user, created] = await User.findOrCreate({
      where: { openid: openid }
    });
    res.send({ success: true, data: user });
  } catch (err) {
    res.status(500).send({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
