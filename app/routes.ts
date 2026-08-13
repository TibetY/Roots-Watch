import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/watching.tsx"),
  route("add", "routes/add.tsx"),
  route("history", "routes/history.tsx"),
  route("settings", "routes/settings.tsx"),
  route("console", "routes/console.tsx"),
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth.callback.tsx"),
] satisfies RouteConfig;
