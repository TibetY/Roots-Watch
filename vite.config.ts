import { reactRouter } from "@react-router/dev/vite";
import netlify from "@netlify/vite-plugin-react-router";
import { defineConfig } from "vite";

export default defineConfig({
  // No Tailwind: the Modernist design system is plain CSS custom properties
  // and component classes (app/app.css), which is how the design ships it.
  //
  // The Netlify plugin has to come after reactRouter() — it wraps the server
  // build the framework plugin produces.
  plugins: [reactRouter(), netlify()],
  resolve: {
    tsconfigPaths: true,
  },
});
