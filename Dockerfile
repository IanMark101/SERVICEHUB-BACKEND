# Stage 1: Base stage with Node.js Alpine image
FROM node:22-alpine AS builder

# Match backend CI and install the libraries needed by Prisma on Alpine.
RUN apk add --no-cache libc6-compat openssl

# Set the working directory for subsequent instructions
WORKDIR /builder

# Copy package.json and package-lock.json to leverage Docker cache
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies) to build the app and generate Prisma client
RUN npm ci

# Copy the rest of the application code
COPY . .

# Generate Prisma Client
RUN npm run db:generate

# Build the application
RUN npm run build

# Stage 2: Runner stage
FROM node:22-alpine AS runner

RUN apk add --no-cache libc6-compat openssl

# Set the working directory in the container
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Reuse the client generated with the lockfile's Prisma version on Alpine.
COPY --from=builder /builder/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /builder/prisma ./prisma

# Copy built artifacts from the builder stage
COPY --from=builder /builder/dist ./dist

# Inform Docker that the container is listening on port 8000 at runtime
EXPOSE 8000

# Define the command to run the app
CMD ["npm", "start"]
