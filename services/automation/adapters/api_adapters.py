# -*- coding: utf-8 -*-
"""
Tier 1 Direct API Application Adapters.
Submits candidate applications directly through public candidate submission APIs
(Greenhouse, Lever, Ashby) with zero browser overhead, sub-second execution, and no CAPTCHA risk.
"""

import os
import json
import requests
from pathlib import Path
from typing import Dict, Any, Optional

class DirectAPIAdapter:
    @staticmethod
    def apply_greenhouse(
        organization: str,
        job_id: str,
        candidate_data: Dict[str, Any],
        cv_path: Path
    ) -> Dict[str, Any]:
        """
        Submits directly to Greenhouse Candidate Application endpoint.
        Endpoint: POST https://boards-api.greenhouse.io/v1/boards/{organization}/jobs/{job_id}
        """
        url = f"https://boards-api.greenhouse.io/v1/boards/{organization}/jobs/{job_id}"
        
        personal = candidate_data.get("personal", {})
        
        # Prepare multipart data
        data = {
            "first_name": personal.get("first_name", ""),
            "last_name": personal.get("last_name", ""),
            "email": personal.get("email", ""),
            "phone": personal.get("phone", ""),
            "location": f"{personal.get('city', '')}, {personal.get('country', '')}",
            "mapped_url_token": job_id
        }

        if personal.get("linkedin"):
            data["urls[LinkedIn]"] = personal["linkedin"]
        if personal.get("github"):
            data["urls[GitHub]"] = personal["github"]

        if not cv_path.exists():
            return {"success": False, "error": f"CV file not found: {cv_path}"}

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json"
        }

        try:
            with open(cv_path, "rb") as f:
                files = {
                    "resume": (cv_path.name, f, "application/pdf")
                }
                resp = requests.post(url, data=data, files=files, headers=headers, timeout=20)

            if resp.status_code in (200, 201):
                return {
                    "success": True,
                    "platform": "greenhouse",
                    "status_code": resp.status_code,
                    "response": resp.text[:300]
                }
            else:
                return {
                    "success": False,
                    "platform": "greenhouse",
                    "status_code": resp.status_code,
                    "error": resp.text[:300]
                }
        except Exception as e:
            return {"success": False, "platform": "greenhouse", "error": str(e)}

    @staticmethod
    def apply_lever(
        organization: str,
        job_id: str,
        candidate_data: Dict[str, Any],
        cv_path: Path
    ) -> Dict[str, Any]:
        """
        Submits directly to Lever Postings Candidate endpoint.
        Endpoint: POST https://jobs.lever.co/v0/postings/{organization}/{job_id}
        """
        url = f"https://jobs.lever.co/v0/postings/{organization}/{job_id}"

        personal = candidate_data.get("personal", {})

        data = {
            "name": personal.get("full_name", f"{personal.get('first_name', '')} {personal.get('last_name', '')}"),
            "email": personal.get("email", ""),
            "phone": personal.get("phone", ""),
            "org": personal.get("city", "France"),
            "urls[LinkedIn]": personal.get("linkedin", ""),
            "urls[GitHub]": personal.get("github", "")
        }

        if not cv_path.exists():
            return {"success": False, "error": f"CV file not found: {cv_path}"}

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json"
        }

        try:
            with open(cv_path, "rb") as f:
                files = {
                    "resume": (cv_path.name, f, "application/pdf")
                }
                resp = requests.post(url, data=data, files=files, headers=headers, timeout=20)

            if resp.status_code in (200, 201):
                return {
                    "success": True,
                    "platform": "lever",
                    "status_code": resp.status_code,
                    "response": resp.text[:300]
                }
            else:
                return {
                    "success": False,
                    "platform": "lever",
                    "status_code": resp.status_code,
                    "error": resp.text[:300]
                }
        except Exception as e:
            return {"success": False, "platform": "lever", "error": str(e)}
