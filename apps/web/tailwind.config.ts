import type { Config } from "tailwindcss";
import { gxTailwindConfig } from "@gx/design-tokens/tailwind";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: gxTailwindConfig.theme?.extend,
  },
  plugins: gxTailwindConfig.plugins ?? [],
} satisfies Config;