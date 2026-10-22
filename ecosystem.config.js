// PM2 process file:  pm2 start ecosystem.config.js  &&  pm2 save
module.exports = {
  apps: [
    {
      name: "harbour-api",
      script: "index.js",
      cwd: __dirname,
      instances: 1,            // keep 1: realtime sockets and the reminder job run in-process
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" },
    },
  ],
};
