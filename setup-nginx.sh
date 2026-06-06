#!/bin/bash
set -e

echo "Updating repositories and installing Nginx / Certbot..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx

echo "Reverting app to port 3000..."
sed -i 's/PORT=80/PORT=3000/g' /root/app/.env
pm2 restart app

echo "Configuring Nginx..."
cat > /etc/nginx/sites-available/teliawebmail.online << 'EOF'
server {
    listen 80;
    server_name teliawebmail.online www.teliawebmail.online;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

ln -sf /etc/nginx/sites-available/teliawebmail.online /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

echo "Restarting Nginx..."
systemctl restart nginx

echo "Running Certbot for teliawebmail.online..."
certbot --nginx -d teliawebmail.online -d www.teliawebmail.online --non-interactive --agree-tos -m admin@teliawebmail.online --redirect

echo "Done."
