# UI/UX Design Document: Virtual Assistant "Capri"

**Theme:** Cyberpunk / Netrunner
**Version:** 1.0.0

## 1. Overview

The Capri chat interface simulates a direct neural communication terminal with a Night City netrunner. The aesthetic is dark and high-contrast, featuring futuristic heads-up display (HUD) elements, subtle system glitches, and neon lights.

## 2. Color Palette

The palette focuses on the extreme contrast between the digital void (black/dark gray) and aggressive neon.

| Color Name | Hex Code | Primary Use | 
| ----- | ----- | ----- | 
| **Cyber Void (Main Background)** | `#0B0B10` | Chat background, modal backgrounds. | 
| **Grid Lines (Secondary Background)** | `#1A1A24` | Input areas, inactive bubble backgrounds. | 
| **Capri Pink (Secondary Color)** | **`#FF0055`** | **Highlights, glow, alerts, Capri's message borders, primary action buttons.** | 
| **Neon Mint (Primary Color)** | `#00FF9D` | User messages, links, "Connected" status. | 
| **Chrome White (Main Text)** | `#E2E8F0` | Main message text, body copy. | 
| **Hacker Green (Secondary Text)** | `#39FF14` | System information, timestamps, placeholders. | 

## 3. Typography

Fonts should evoke the feeling of a heads-up display (HUD) terminal.

* **Headers and Names:** `Orbitron` or `Rajdhani` (Weights 600, 700).
  * *Effect:* Uppercase letters, slight letter-spacing (2px).

* **Body Text (Messages):** `Rajdhani` or `Inter` (Weight 400).
  * *Effect:* High readability, 16px base size.

* **Data and System (Terminals):** `Fira Code` or `Space Mono`.
  * *Effect:* Used for system logs, code blocks, and typing indicators.

## 4. UI Components

### 4.1. Main Chat Container

* **Background:** `#0B0B10` with a faint grid pattern or horizontal scanlines at 5% opacity.
* **Borders:** Chamfered (sci-fi style, no perfectly rounded corners). Bottom border glowing in `#FF0055`.

### 4.2. Message Bubbles

**Capri's Messages (Assistant):**

* **Alignment:** Left.
* **Background:** Transparent with a slight dark-to-`#FF0055` gradient (10% opacity).
* **Border:** Solid 3px left border in `#FF0055`.
* **Detail:** A jack-in icon or Capri's logo next to the name, glowing hot pink.
* **Font:** `Chrome White` for the text.

**User's Messages:**

* **Alignment:** Right.
* **Background:** Transparent with a slight gradient to `#00FF9D` (10% opacity).
* **Border:** Solid 3px right border in `#00FF9D`.
* **Font:** `Chrome White` for the text.

### 4.3. Input Area

* **Background:** `#1A1A24`
* **Text (Typing):** `Chrome White`
* **Placeholder:** "Inject command..." in `Hacker Green` (50% opacity).
* **Typing Cursor:** A solid rectangular block (not a thin line) blinking in `#FF0055`.
* **Send Button:** Sharp arrow icon, static color `#E2E8F0`, but heavily glows in `#FF0055` with a slight glitch effect on hover.

## 5. Visual Effects (CSS Vibe)

* **Neon Glow:** Use `box-shadow` and `text-shadow` in `#FF0055` to create the signature Cyberpunk light emission on active elements.
  * *CSS Example:* `box-shadow: 0 0 5px #FF0055, 0 0 15px #FF0055;`
* **Glitch Effect:** When receiving a new message from Capri, the text should have a quick "glitch" animation (RGB split for a fraction of a second) before stabilizing.
* **Scanlines:** A CSS overlay with `pointer-events: none` displaying very subtle horizontal lines moving up the screen, simulating an old monitor or cyber-optic vision.

## 6. States and Interactions

* **Capri "Typing...":** Instead of the standard three dots, display a loading green terminal log: `[Decoding protocol_]` or `[Processing // ICE_Breaker]`.
* **Hover on Links/Buttons:** The element gets a thick underline background in `#FF0055` and the text changes to black (color inversion).
* **Connection Error:** The screen flickers with a flashing `#FF0055` warning: `[SYSTEM WARNING: NEURAL SIGNAL LOST]`.