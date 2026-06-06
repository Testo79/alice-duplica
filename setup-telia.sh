#!/bin/bash
set -e

echo "Configuring Nginx for teliawebmail.online..."
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
rm -f /etc/nginx/sites-enabled/alicewebmail.online

echo "Restarting Nginx..."
systemctl restart nginx

echo "Running Certbot for teliawebmail.online..."
certbot --nginx -d teliawebmail.online --non-interactive --agree-tos -m admin@teliawebmail.online --redirect

echo "Done."
