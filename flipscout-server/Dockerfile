# Playwright's image because re-login needs a real browser; the push path
# itself is plain HTTP and needs none of it.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm install playwright@1.49.1

COPY src ./src

# The session cookie and the queue live here. Mount a volume over it, or a
# restart loses the session and REI emails another verification code.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080 \
    REI_STATE_PATH=/app/data/rei-session.json \
    QUEUE_PATH=/app/data/queue.json
EXPOSE 8080

# Not root: this process holds live CRM credentials.
USER pwuser

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
