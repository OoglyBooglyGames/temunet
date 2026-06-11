{
  "version": 2,
  "builds": [
    {
      "src": "api/proxy.js",
      "use": "@vercel/node"
    },
    {
      "src": "public/**",
      "use": "@vercel/static"
    }
  ],
  "routes": [
    {
      "src": "/api/proxy",
      "dest": "/api/proxy.js"
    },
    {
      "src": "/(.*)",
      "dest": "/public/$1"
    }
  ]
}
