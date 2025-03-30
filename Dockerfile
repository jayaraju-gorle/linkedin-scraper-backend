# Use an official Node.js runtime as the base image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies for Chromium
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
    libglib2.0-0 \
    libxss1 \
    libxfixes3 \
    alsa-lib \
    atk \
    at-spi2-atk \
    cups-libs \
    dbus-libs \
    expat \
    fontconfig \
    freetype \
    gcc-c++ \
    glib2 \
    glibc \
    gtk3 \
    libX11 \
    libXScrnSaver \
    libXcursor \
    libXrender \
    libgcc \
    libstdc++ \
    libxcb \
    pango \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port that the app runs on
EXPOSE 3001

# Define the command to run the application
CMD [ "node", "index.js" ]
