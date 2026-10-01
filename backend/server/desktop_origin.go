package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// The packaged desktop WebUI lives on Tauri's local origin. It still uses
// normal panel authentication; CORS only permits these exact local origins.
func desktopOriginMiddleware(c *gin.Context) {
	origin := c.GetHeader("Origin")
	switch origin {
	case "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost":
		c.Writer.Header().Add("Vary", "Origin")
		c.Header("Access-Control-Allow-Origin", origin)
		if c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
			switch c.GetHeader("Access-Control-Request-Method") {
			case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE":
			default:
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			for _, header := range strings.Split(c.GetHeader("Access-Control-Request-Headers"), ",") {
				switch strings.ToLower(strings.TrimSpace(header)) {
				case "", "authorization", "content-type":
				default:
					c.AbortWithStatus(http.StatusForbidden)
					return
				}
			}
			c.Header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
	default:
		if origin != "" && c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
	}
	c.Next()
}
