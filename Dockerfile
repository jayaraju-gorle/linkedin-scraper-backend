FROM node:18

# Install dependencies
RUN apt-get update && apt-get install -y \
  libx11-xcb1 \
  libxrandr2 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxtst6 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libasound2 \
  libpango-1.0-0 \
  libcairo2 \
  libfontconfig1 \
  libgconf-2-4 \
  libxi6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8080
CMD ["node", "index.js"]