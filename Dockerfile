FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

COPY src ./src
COPY tsconfig.json ./

RUN npm run build

FROM node:24-alpine AS release

WORKDIR /app

# Copy only the necessary files from the build stage
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./

ENV NODE_ENV=production

# Install production dependencies only
RUN npm ci --ignore-scripts --omit=dev

# Set the entry point for the container
ENTRYPOINT ["node", "dist/index.js"]
