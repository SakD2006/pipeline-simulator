FROM node:18-alpine

# Install g++ and OpenMP support
RUN apk add --no-cache g++ libc-dev libgomp

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source files
COPY server.js .
COPY pipeline_fixed.cpp .
COPY json.hpp .

# Compile C++ code
RUN g++ -fopenmp pipeline_fixed.cpp -o pipeline_web

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
