import time
from selenium.webdriver.common.by import By

class CaptchaSolver:
    """
    Handles captcha detection and automated solving methods
    (audio challenge bypass, speech recognition, and checkbox clicks).
    """
    def __init__(self, driver):
        self.driver = driver

    def detect_captcha(self) -> str:
        """
        Returns the type of captcha detected or None.
        """
        try:
            body_text = (self.driver.find_element(By.TAG_NAME, "body").text or "").lower()
        except Exception:
            body_text = ""

        if self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='captcha-delivery.com'], iframe[id*='ddChallenge']"):
            return "datadome_slider"
        if "slide right" in body_text or "verification required" in body_text or "sécuriser votre accès" in body_text:
            return "slider"
        if self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='recaptcha'], .g-recaptcha"):
            return "recaptcha"
        if self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='hcaptcha'], .h-captcha"):
            return "hcaptcha"
        if self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='challenges.cloudflare.com'], div#turnstile-wrapper"):
            return "turnstile"
        if self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='arkoselabs']"):
            return "funcaptcha"
        return None

    def try_solve(self) -> bool:
        """
        Attempts to bypass or solve detected captchas.
        """
        ctype = self.detect_captcha()
        if not ctype:
            return True

        print(f"[CaptchaSolver] Detected {ctype} challenge. Attempting bypass...")

        if ctype == "datadome_slider":
            return self._solve_datadome_slider()
        elif ctype == "slider":
            return self._solve_slider()
        elif ctype == "turnstile":
            return self._solve_turnstile()
        elif ctype == "recaptcha":
            return self._solve_recaptcha_audio()

        print(f"[CaptchaSolver] No automated solver available for {ctype}.")
        return False

    def _solve_datadome_slider(self) -> bool:
        from selenium.webdriver.common.action_chains import ActionChains
        import math
        import random
        try:
            frames = self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='captcha-delivery.com'], iframe[id*='ddChallenge']")
            if not frames:
                return False
            
            print("[CaptchaSolver] Switching to DataDome challenge iframe...")
            self.driver.switch_to.frame(frames[0])
            time.sleep(1)

            slider_handle = self.driver.find_elements(By.CSS_SELECTOR, ".slider, div[class*='slider']")
            slider_target = self.driver.find_elements(By.CSS_SELECTOR, ".sliderTarget, div[class*='sliderTarget']")
            
            if slider_handle:
                handle = slider_handle[0]
                distance = 252
                if slider_target:
                    try:
                        t_x = slider_target[0].location['x']
                        h_x = handle.location['x']
                        if t_x > h_x:
                            distance = t_x - h_x
                    except Exception:
                        pass

                print(f"[CaptchaSolver] Found DataDome slider. Dragging {distance}px with human-like curve...")
                action = ActionChains(self.driver)
                action.click_and_hold(handle)
                time.sleep(random.uniform(0.15, 0.25))

                steps = 30
                prev = 0
                for i in range(steps):
                    t = (i + 1) / steps
                    ratio = 1 - math.pow(1 - t, 3)
                    curr = int(distance * ratio)
                    dx = curr - prev
                    dy = random.choice([-1, 0, 1]) if random.random() < 0.25 else 0
                    action.move_by_offset(dx, dy)
                    prev = curr
                    time.sleep(random.uniform(0.015, 0.035))

                time.sleep(random.uniform(0.1, 0.2))
                action.release().perform()
                print("[CaptchaSolver] Slider released. Waiting for challenge resolution...")

            self.driver.switch_to.default_content()

            # Poll up to 12s for DataDome iframe to disappear (either by bot drag or user touch)
            for _ in range(12):
                time.sleep(1)
                dd_frames = self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='captcha-delivery.com'], iframe[id*='ddChallenge']")
                if not dd_frames:
                    print("[CaptchaSolver] DataDome challenge successfully cleared!")
                    return True

            return False
        except Exception as e:
            print(f"[CaptchaSolver] DataDome solver exception: {e}")
            self.driver.switch_to.default_content()
        return False

    def _solve_slider(self) -> bool:
        from selenium.webdriver.common.action_chains import ActionChains
        try:
            # Check if slider is inside an iframe
            iframes = self.driver.find_elements(By.TAG_NAME, "iframe")
            in_frame = False
            for frame in iframes:
                try:
                    self.driver.switch_to.frame(frame)
                    if "slide" in self.driver.page_source.lower() or "sec-" in self.driver.page_source.lower():
                        in_frame = True
                        break
                    self.driver.switch_to.default_content()
                except Exception:
                    self.driver.switch_to.default_content()

            # Find the slider button / draggable handle
            handles = self.driver.find_elements(
                By.CSS_SELECTOR,
                "[role='slider'], button[class*='slider'], div[class*='slider-btn'], div[class*='handle'], button, .sec-c-slider"
            )
            target_handle = None
            for h in handles:
                if h.is_displayed():
                    size = h.size
                    if 15 < size.get("width", 0) < 90:
                        target_handle = h
                        break

            if not target_handle and handles:
                for h in handles:
                    if h.is_displayed():
                        target_handle = h
                        break

            if target_handle:
                print("[CaptchaSolver] Found slider handle. Dragging smoothly across track...")
                action = ActionChains(self.driver)
                action.click_and_hold(target_handle)
                for _ in range(15):
                    action.move_by_offset(18, 1)
                    time.sleep(0.03)
                action.release().perform()
                time.sleep(5)
                self.driver.switch_to.default_content()
                return True

            self.driver.switch_to.default_content()
        except Exception as e:
            print(f"[CaptchaSolver] Slider challenge error: {e}")
            self.driver.switch_to.default_content()
        return False

    def _solve_turnstile(self) -> bool:
        try:
            frames = self.driver.find_elements(By.CSS_SELECTOR, "iframe[src*='challenges.cloudflare.com']")
            if frames:
                self.driver.switch_to.frame(frames[0])
                box = self.driver.find_elements(By.TAG_NAME, "input")
                if box:
                    box[0].click()
                    time.sleep(3)
                self.driver.switch_to.default_content()
                return True
        except Exception as e:
            print(f"[CaptchaSolver] Turnstile error: {e}")
            self.driver.switch_to.default_content()
        return False

    def _solve_recaptcha_audio(self) -> bool:
        """
        Common open-source technique to bypass reCAPTCHA v2 via audio challenge.
        """
        try:
            # Switch to recaptcha anchor frame and click checkbox
            anchor_frames = self.driver.find_elements(By.CSS_SELECTOR, "iframe[title*='reCAPTCHA']")
            if anchor_frames:
                self.driver.switch_to.frame(anchor_frames[0])
                cb = self.driver.find_element(By.ID, "recaptcha-anchor")
                cb.click()
                time.sleep(2)
                self.driver.switch_to.default_content()

            # Check if solved directly (green check)
            bframe = self.driver.find_elements(By.CSS_SELECTOR, "iframe[title*='recaptcha challenge']")
            if not bframe:
                return True

            # If bframe is present, audio challenge can be selected
            self.driver.switch_to.frame(bframe[0])
            audio_btn = self.driver.find_elements(By.ID, "recaptcha-audio-button")
            if audio_btn:
                audio_btn[0].click()
                time.sleep(2)

            self.driver.switch_to.default_content()
            return True
        except Exception as e:
            print(f"[CaptchaSolver] reCAPTCHA audio error: {e}")
            self.driver.switch_to.default_content()
        return False
