FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm install
COPY server ./server
RUN npm run build --workspace server
WORKDIR /app/server
EXPOSE 3001
CMD ["sh","-c","npx prisma db push && node dist/main.js"]
