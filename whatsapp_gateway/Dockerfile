FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV WHATSAPP_AUTH_DIR=/data/auth \
    WHATSAPP_HTTP_HOST=0.0.0.0 \
    WHATSAPP_HTTP_PORT=5174
VOLUME ["/data"]
EXPOSE 5174
CMD ["node", "whatsapp_service.mjs"]
