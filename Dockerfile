FROM node:22-alpine
WORKDIR /app
COPY package.json main.js ./
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "main.js"]
