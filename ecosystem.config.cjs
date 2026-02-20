module.exports = {
  apps: [
    {
      name: 'polymarket-bot',
      script: 'bot/index.js',
      cwd: __dirname,
      node_args: '--env-file=./bot/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
    },
  ],
};
