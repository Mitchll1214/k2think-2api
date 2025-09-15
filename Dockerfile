# 使用官方 Node.js 18 Alpine 镜像（支持 ARM 架构）
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm install --only=production

# 复制应用代码
COPY src/ ./src/

# 暴露端口 2001
EXPOSE 2001

# 设置启动命令
CMD ["node", "src/index.js"]
