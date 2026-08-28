FROM node:20-bullseye

# Install Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps
COPY package*.json ./
RUN npm install

# Python deps
RUN pip3 install numpy sentence_transformers

COPY . .

EXPOSE 4000
CMD ["npm", "start"]
