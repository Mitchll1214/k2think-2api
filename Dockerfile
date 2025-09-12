# 使用官方Node.js运行时作为基础镜像
FROM node:16-alpine

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果有的话）
COPY package*.json ./

# 安装依赖
RUN npm install --omit=dev

# 复制应用程序代码
COPY src/ ./src/

# 暴露端口
EXPOSE 2004

# 设置环境变量（如果需要）
ENV CLIENT_API_KEY=""

# 启动应用程序
CMD [ "npm", "start" ]
