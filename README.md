# K2Think-2API

一个将 K2Think AI 服务转换为 OpenAI 兼容 API 的代理服务，支持流式和非流式响应。

## 特性

- ✅ OpenAI API 兼容格式
- ✅ 支持流式响应 (Server-Sent Events)
- ✅ 支持非流式响应
- ✅ API 密钥认证
- ✅ Docker 容器化部署
- ✅ ARM 架构支持
- ✅ 健康检查端点
- ✅ 优雅关闭

## 文件结构

```
k2think-2api/
├── src/
│   └── index.js          # 主应用代码
├── package.json          # 项目依赖
├── Dockerfile           # Docker 构建文件
├── docker-compose.yml   # Docker Compose 配置
├── .dockerignore        # Docker 忽略文件
├── .env.example         # 环境变量示例
└── README.md           # 说明文档
```

## 快速开始

### 使用 Docker Compose（推荐）

1. 克隆或创建项目目录：
```bash
mkdir k2think-2api && cd k2think-2api
```

2. 创建所有必要的文件（参考上面的文件结构）

3. 配置环境变量（可选）：
```bash
cp .env.example .env
# 编辑 .env 文件设置 API 密钥
```

4. 构建并启动服务：
```bash
docker-compose up -d --build
```

### 使用 Docker

```bash
# 构建镜像
docker build -t k2think-2api .

# 运行容器
docker run -d \
  --name k2think-2api \
  -p 2001:2001 \
  k2think-2api
```

### 本地开发

```bash
# 安装依赖
npm install

# 启动服务
npm start

# 开发模式（自动重启）
npm run dev
```

## API 使用

### 获取模型列表

```bash
curl http://localhost:2001/v1/models
```

### 聊天补全（非流式）

```bash
curl -X POST http://localhost:2001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "MBZUAI-IFM/K2-Think",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": false
  }'
```

### 聊天补全（流式）

```bash
curl -X POST http://localhost:2001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "MBZUAI-IFM/K2-Think",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": true
  }'
```

### 健康检查

```bash
curl http://localhost:2001/health
```

## 环境变量

- `PORT`: 服务端口，默认 2001
- `CLIENT_API_KEY`: API 密钥认证，多个密钥用逗号分隔（可选）
- `NODE_ENV`: Node.js 环境，默认 production

## API 认证

如果设置了 `CLIENT_API_KEY` 环境变量，则需要在请求头中提供 API 密钥：

```
Authorization: Bearer your-api-key
```

## 支持的模型

- `MBZUAI-IFM/K2-Think`

## Docker 镜像优化

- 使用 Alpine Linux 基础镜像，体积小
- 支持 ARM 和 x86 架构
- 只安装生产依赖
- 非 root 用户运行
- 健康检查配置

## 故障排除

### 检查服务状态
```bash
docker-compose logs k2think-2api
```

### 重启服务
```bash
docker-compose restart k2think-2api
```

### 重新构建
```bash
docker-compose down
docker-compose up -d --build
```

## 开发

### 添加新功能
1. 修改 `src/index.js`
2. 重新构建镜像：`docker-compose up -d --build`

### 调试
查看日志：
```bash
docker-compose logs -f k2think-2api
```

## 许可证

MIT License
