const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const app = express();

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
const User = sequelize.define('User', {
  openid: { type: DataTypes.STRING, allowNull: false, unique: true },
  nickName: { type: DataTypes.STRING, defaultValue: '微信用户' },
  avatarUrl: { type: DataTypes.STRING, defaultValue: '' } // 增加这个字段
}, {
  // 关键配置：强制指向你手动建的小写 users 表
  tableName: 'Users', 
  timestamps: true // 必须开启，因为 Sequelize 默认需要 createdAt 和 updatedAt
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

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`🚀 服务正式启动，端口: ${PORT}`));
