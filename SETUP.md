# Server Setup Guide

## 1. Repository Setup
```bash
# Pull latest changes from repository
git fetch origin main
git reset --hard origin/main
```

## 2. PostgreSQL Installation and Setup
```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start and enable PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Connect to PostgreSQL as superuser
sudo -u postgres psql
```

In PostgreSQL prompt:
```sql
-- Create database (if not exists)
CREATE DATABASE "BotDB";

-- Create user and set password
CREATE USER strobe_dev WITH PASSWORD 'your_secure_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE "BotDB" TO strobe_dev;
\c "BotDB"
GRANT ALL PRIVILEGES ON SCHEMA public TO strobe_dev;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO strobe_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO strobe_dev;

-- Exit PostgreSQL prompt
\q
```

## 3. Environment Setup
Create or update `.env` file:
```bash
# Database configuration
DATABASE_URL="postgresql://strobe_dev:your_secure_password@localhost:5432/BotDB"

# API Keys
MORALIS_API_KEY="your_moralis_api_key"
BIRDEYE_API_KEY="your_birdeye_api_key"

# Discord Configuration
DISCORD_TOKEN="your_discord_bot_token"
PNL_DISCORD_CHANNEL_ID="your_channel_id"
```

## 4. Application Setup
```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate deploy

# Build the application
npm run build
```

## 5. Running the Application
Using PM2 (recommended for production):
```bash
# Install PM2 if not installed
npm install -g pm2

# Start application with PM2
pm2 start npm --name "strobe-bot" -- start

# Other useful PM2 commands
pm2 status              # Check status
pm2 logs strobe-bot    # View logs
pm2 restart strobe-bot # Restart application
pm2 stop strobe-bot    # Stop application
```

Without PM2:
```bash
npm start
```

## 6. Maintenance Commands
```bash
# View database with Prisma Studio
npx prisma studio

# Reset database (if needed)
npx prisma migrate reset

# Update application
git fetch origin main
git reset --hard origin/main
npm install
npx prisma generate
npm run build
pm2 restart strobe-bot
```

## Important Notes
1. Always backup your database before major changes
2. Keep your environment variables secure
3. Monitor your application logs regularly
4. Update your dependencies periodically
5. Ensure your firewall settings allow necessary connections

## Troubleshooting
If you encounter database permission issues:
1. Verify PostgreSQL service is running: `sudo systemctl status postgresql`
2. Check database connection: `psql -U strobe_dev -d BotDB -h localhost`
3. Review logs: `sudo tail -f /var/log/postgresql/postgresql-*.log` 
