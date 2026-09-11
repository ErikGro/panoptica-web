# panoptica web
Interactive panoptica web app with static frontend client and server side evaluation

## Development

## Deployment

## Server configuration
### caddyfile:
```
panoptica.koflerlab.org {
    handle /api/* {
        reverse_proxy 127.0.0.1:8000 # Locally exposed server socket
    }

    handle {
        root * /srv/frontend
        try_files {path} /index.html
        file_server
    }
}
```