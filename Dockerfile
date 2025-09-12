# 使用官方Node.js运行时作为基础镜像
FROM node:16-alpine

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果有的话）
COPY package*.json ./

# 安装依赖
RUN npm install --prod

# 复制应用程序代码
COPY src/ ./src/

# 暴露端口
EXPOSE 2004

# 启动应用程序
CMD [ "node", "src/index.js" ]
