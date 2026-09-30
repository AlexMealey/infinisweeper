FROM php:8.3-apache

# Production php.ini: no display_errors, sane limits.
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

COPY docker/apache.conf /etc/apache2/conf-available/infinisweeper.conf
COPY docker/tls.conf /etc/apache2/sites-available/infinisweeper-tls.conf
RUN a2enconf infinisweeper && a2enmod ssl && a2ensite infinisweeper-tls

WORKDIR /var/www/html

# Only the files the site actually serves — docs, git metadata and room saves stay out of the image.
COPY index.html manifest.json sw.js ./
COPY css ./css
COPY icons ./icons
COPY js ./js
COPY lib ./lib
COPY php ./php
COPY docker/entrypoint.sh /usr/local/bin/infinisweeper-entrypoint

# Normalise permissions (some checkouts are 777) and create the save directory.
RUN find . -type d -exec chmod 755 {} + \
 && find . -type f -exec chmod 644 {} + \
 && chmod 755 /usr/local/bin/infinisweeper-entrypoint \
 && mkdir -p data/rooms \
 && chown www-data:www-data data/rooms

# Multiplayer room saves. Bind-mount this to the host to keep them across rebuilds.
VOLUME /var/www/html/data/rooms
# HTTPS certificate, outside the web root. Bind-mount it so rebuilds keep the same certificate.
VOLUME /var/lib/infinisweeper/tls

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -o /dev/null http://localhost/ || exit 1

ENTRYPOINT ["infinisweeper-entrypoint"]
CMD ["apache2-foreground"]
