"""Offline tests on recorded fixtures (no network). Run: .venv/bin/python -m unittest -v"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from meetings import config
from meetings.addresses import find_candidates
from meetings.archive import RawArchive, sha256_hex
from meetings.escribe.agenda import parse_meeting_html
from meetings.escribe.calendar import DiscoveredMeeting, month_windows, normalize_calendar_meeting
from meetings.escribe.pipeline import build_records
from meetings.http import Fetcher, looks_like_cloudflare_challenge
from meetings.legistar import normalize_event, normalize_items
from meetings.lifecycle import classify, parse_tally, result_phrase
from meetings.pdftext import extract_pages
from meetings.records import EVENT_STATUSES, LIFECYCLES

FIX = Path(__file__).parent / "fixtures"
AGENDA = (FIX / "escribe_agenda_formal_2026-09-15.html").read_text("utf-8")
MINUTES = (FIX / "escribe_minutes_formal_2026-09-08.html").read_text("utf-8")
CALENDAR = json.loads((FIX / "escribe_calendar_2026-09.json").read_text("utf-8"))


class BodyAllowlistTests(unittest.TestCase):
    def test_allowlisted_bodies_canonicalize(self):
        self.assertEqual(config.canonical_body("City Council Formal Session"), "City Council Formal Session")
        self.assertEqual(config.canonical_body("Budget, Finance And Audit Standing Committee"), "Budget, Finance and Audit Standing Committee")
        self.assertEqual(config.canonical_body("Rules Committee"), "Rules Standing Committee")  # Legistar spelling
        self.assertEqual(config.canonical_body("City Council"), "City Council Formal Session")  # Legistar spelling
        self.assertEqual(config.canonical_body("Community Development Block Grant"), "Community Development Block Grant")

    def test_test_demo_training_bodies_excluded(self):
        for name in ["08222019 Mock Meeting Test", "Automation Test Meeting", "City Clerk Training Agenda", "Keith's Demo Meeting",
                     "OCP Demo Meeting", "eSCRIBE Team 1", "eSCRIBE Meeting Type", "James Test", "Training James", "City Council Formal Session Test"]:
            self.assertIsNone(config.canonical_body(name), name)

    def test_non_allowlisted_public_bodies_excluded(self):
        for name in ["City Council Closed Session", "City Council Executive Session", "City Council Evening Community Meeting", "City Council New Business"]:
            self.assertIsNone(config.canonical_body(name), name)

    def test_calendar_fixture_filters(self):
        kept = [normalize_calendar_meeting(m, sha256="x", fetched_at="2026-09-21T00:00:00Z") for m in CALENDAR["d"]]
        kept = [m for m in kept if m]
        self.assertEqual(len(kept), 10)
        bodies = {m.body for m in kept}
        self.assertIn("City Council Formal Session", bodies)
        fs = [m for m in kept if m.date == "2026-09-15"][0]
        self.assertEqual(fs.meeting_id, "1a03d6a7-1975-4aa5-8642-0f158777bf74")
        self.assertTrue(fs.agenda_html_url.endswith("Meeting.aspx?Id=1a03d6a7-1975-4aa5-8642-0f158777bf74&Agenda=Agenda&lang=English"))
        self.assertTrue(fs.agenda_pdf_url.endswith("/FileStream.ashx?DocumentId=277592"))
        held = [m for m in kept if m.date == "2026-09-08"][0]
        self.assertTrue(held.minutes_html_url.endswith("&Agenda=PostMinutes&lang=English"))
        self.assertEqual(month_windows(date(2026, 7, 23), date(2026, 10, 21)), [
            (date(2026, 7, 1), date(2026, 8, 1)), (date(2026, 8, 1), date(2026, 9, 1)), (date(2026, 9, 1), date(2026, 10, 1)), (date(2026, 10, 1), date(2026, 11, 1))])


class ItemExtractionTests(unittest.TestCase):
    def test_agenda_header(self):
        pm = parse_meeting_html(AGENDA)
        self.assertEqual(pm.date, "2026-09-15")
        self.assertIn("CITY COUNCIL FORMAL SESSION", pm.title)
        self.assertIn("1340 Coleman A. Young Municipal Center", pm.location)
        self.assertFalse(pm.cancelled_in_header)

    def test_agenda_items_numbers_titles_sections_attachments(self):
        pm = parse_meeting_html(AGENDA)
        self.assertEqual(len(pm.items), 126)
        by = {it.item_number: it for it in pm.items}
        self.assertEqual(by["1"].title, "ROLL CALL")
        self.assertEqual(by["7"].title, "BUDGET, FINANCE AND AUDIT STANDING COMMITTEE")
        self.assertEqual(by["7.1"].parent_item_number, "7")
        self.assertEqual(by["7.1"].section, "BUDGET, FINANCE AND AUDIT STANDING COMMITTEE / MISCELLANEOUS")
        self.assertEqual(by["7.1"].description,
                         "Submitting memorandum relative to request for Information – Implementation and Status of the 2023 Property Tax Reform Ordinance Addendum.")
        self.assertEqual([a["document_id"] for a in by["7.1"].attachments], ["277509", "277510"])
        self.assertEqual(by["7.1"].attachments[0]["title"],
                         "Addendum to Request for Information – Implementation and Status of the 2023 Property Tax Reform Ordinance.pdf")
        self.assertEqual(by["7.1"].attachments[0]["url"], "/filestream.ashx?DocumentId=277509")
        # group header carries to following siblings
        self.assertEqual(by["8.3"].section, by["8.2"].section)
        self.assertIsNone(by["7.1"].minutes_text)  # agenda view has no recorded action
        self.assertTrue(by["14"].is_public_comment)

    def test_minutes_items_carry_verbatim_action(self):
        pm = parse_meeting_html(MINUTES)
        self.assertEqual(pm.date, "2026-09-08")
        by = {it.item_number: it for it in pm.items}
        self.assertEqual(by["7.2"].minutes_text, "Approved 9-0")
        self.assertTrue(by["7.2"].description.startswith("Contract No. 6003631-A2"))
        refer = [it for it in pm.items if it.minutes_text and it.minutes_text.startswith("REFER TO THE COMMITTEE")]
        self.assertGreater(len(refer), 50)
        self.assertEqual(len([it for it in pm.items if it.minutes_text == "Remove from agenda 9-0"]), 1)

    def test_parser_is_deterministic(self):
        a = [(i.item_number, i.title, i.description, i.minutes_text) for i in parse_meeting_html(MINUTES).items]
        b = [(i.item_number, i.title, i.description, i.minutes_text) for i in parse_meeting_html(MINUTES).items]
        self.assertEqual(a, b)


class LifecycleTests(unittest.TestCase):
    def test_mapping_from_recorded_text(self):
        cases = {
            "Approved 9-0": "Approved",
            "Approved as Amended 9-0 (Joined by Member Denzel McCampbell)": "Approved",
            "Approved 9-0 with Waiver Waiver #3": "Approved",
            "REFER TO THE COMMITTEE 9-0": "Referred",
            "REFER TO THE BUDGET, FINANCE AND AUDIT STANDING COMMITTEE 9-0": "Referred",
            "Remove from agenda 9-0": "Withdrawn",
            "Withdrawn": "Withdrawn",
            "Note: Line item brought back later within the agenda. Member Miller left seat Quorum 8 Postpone 8-0 (Miller not in seat)": "Deferred",
            "Held in committee": "Deferred",
            "Denied 2-7": "Denied",
            "Failed 4-5": "Denied",
            "Present: Member Benson, Member Johnson": "Unknown",
            "The Journal of the Session of Tuesday, July 21, 2026, will be approved.": "Approved",
        }
        for text, expected in cases.items():
            lifecycle, basis = classify(text, meeting_held=True)
            self.assertEqual(lifecycle, expected, f"{text!r} -> {lifecycle} ({basis})")
            self.assertIn(lifecycle, LIFECYCLES)

    def test_no_text(self):
        self.assertEqual(classify(None, meeting_held=False)[0], "Scheduled")
        self.assertEqual(classify("", meeting_held=True)[0], "Unknown")

    def test_tally_and_result(self):
        self.assertEqual(parse_tally("Approved 9-0"), {"yes": 9, "no": 0})
        self.assertEqual(parse_tally("Postpone 8-0 (Miller not in seat)"), {"yes": 8, "no": 0})
        self.assertIsNone(parse_tally("Approved"))
        self.assertIsNone(parse_tally("Contract 2026-086"))  # 4-digit year is not a tally
        self.assertEqual(result_phrase("REFER TO THE COMMITTEE 9-0"), "REFER TO THE COMMITTEE")


class AddressCandidateTests(unittest.TestCase):
    def test_street_patterns(self):
        text = ("Petition of X (#2026-157), request to vacate 19160 Evergreen Road and 1301 East Warren Avenue near "
                "7 Mile Road; parcel 16010838. and parcel 22079766-8; Ward 17 Item 000123; call (313) 224-3443; $68,346.00; 4500 Woodward.")
        c = find_candidates(text)
        texts = {x.text for x in c}
        self.assertIn("19160 Evergreen Road", texts)
        self.assertIn("1301 East Warren Avenue", texts)
        self.assertIn("16010838.", texts)
        self.assertIn("22079766-8", texts)
        self.assertIn("Ward 17 Item 000123", texts)
        self.assertIn("4500 Woodward", texts)
        self.assertTrue(all(x.location_confidence == "needs_review" for x in c))
        self.assertFalse(any("224-3443" in t or "68,346" in t for t in texts))

    def test_no_false_positive_on_plain_text(self):
        self.assertEqual(find_candidates("Approved 9-0 with Waiver #3 on September 8, 2026 for Contract No. 6003631-A2"), [])


class ArchiveTests(unittest.TestCase):
    def test_idempotent_put(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = RawArchive(Path(tmp))
            body = b"<html>agenda</html>"
            e1, new1 = a.put("escribe", "m1", "agenda_html", "https://x/1", body, "2026-09-21T10:00:00Z", "text/html")
            e2, new2 = a.put("escribe", "m1", "agenda_html", "https://x/1", body, "2026-09-22T10:00:00Z", "text/html")
            self.assertTrue(new1); self.assertFalse(new2)
            self.assertEqual(e1.sha256, sha256_hex(body))
            self.assertEqual(e2.first_fetched_at, "2026-09-21T10:00:00Z")
            self.assertEqual(e2.last_fetched_at, "2026-09-22T10:00:00Z")
            self.assertEqual(len(a.read_index("escribe", "m1")), 1)
            self.assertEqual(len(list((Path(tmp) / "escribe" / "m1").glob("*.html"))), 1)
            e3, new3 = a.put("escribe", "m1", "agenda_html", "https://x/1", b"<html>changed</html>", "2026-09-23T10:00:00Z", "text/html")
            self.assertTrue(new3)
            self.assertEqual(len(a.read_index("escribe", "m1")), 2)
            self.assertEqual(len(list((Path(tmp) / "escribe" / "m1").glob("*.html"))), 2)
            self.assertEqual(a.latest("escribe", "m1", "agenda_html").sha256, e3.sha256)
            self.assertEqual(a.read_bytes(e1), body)


class HttpPolicyTests(unittest.TestCase):
    def test_cloudflare_detection_on_recorded_403(self):
        body = (FIX / "cloudflare_challenge_403.html").read_bytes()
        self.assertTrue(looks_like_cloudflare_challenge(403, {"server": "cloudflare"}, body))
        self.assertTrue(looks_like_cloudflare_challenge(200, {"cf-mitigated": "challenge"}, b""))
        self.assertFalse(looks_like_cloudflare_challenge(200, {"server": "cloudflare"}, b"<html>ok</html>"))
        self.assertFalse(looks_like_cloudflare_challenge(404, {"server": "cloudflare"}, b"not found"))

    def test_rate_limit_and_user_agent(self):
        f = Fetcher(honor_robots=False)
        self.assertEqual(f.user_agent, "DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)")
        self.assertEqual(f.min_interval, 2.0)
        slept: list[float] = []
        t = [100.0]
        f.sleep = lambda s: (slept.append(s), t.__setitem__(0, t[0] + s))
        f.clock = lambda: t[0]
        f._throttle("h"); t[0] += 0.5; f._throttle("h")
        self.assertAlmostEqual(slept[0], 1.5, places=3)


class RecordBuildTests(unittest.TestCase):
    def _meeting(self, mid, d, minutes=True):
        return DiscoveredMeeting(mid, "City Council Formal Session", "City Council Formal Session", f"{d}T10:00:00", d,
                                 "1340 CAYMC", True, f"https://pub-detroitmi.escribemeetings.com/Meeting.aspx?Id={mid}&Agenda=Agenda&lang=English",
                                 None, f"https://pub-detroitmi.escribemeetings.com/Meeting.aspx?Id={mid}&Agenda=PostMinutes&lang=English" if minutes else None,
                                 None, None, "cal", "2026-09-21T00:00:00Z")

    def test_records_from_minutes(self):
        now = datetime(2026, 9, 21, 12, 0, 0)
        m = self._meeting("c57c3ddd-dfee-4e90-bf84-e14e819c8c91", "2026-09-08")
        event, items, votes, docs = build_records(m, agenda=None, minutes=parse_meeting_html(MINUTES), agenda_entry=None, minutes_entry=None,
                                                  snapshot_id="run-1", observed_at="2026-09-21T01:02:03Z", now=now)
        self.assertEqual(event.status, "held"); self.assertIn(event.status, EVENT_STATUSES)
        d = event.to_dict()
        for k in ("source_id", "source_snapshot_id", "observed_at", "effective_at", "limitations"):
            self.assertIn(k, d)
        self.assertEqual(d["limitations"], ["An agenda item is not an approval; an approval is not execution."])
        self.assertEqual(d["source_id"], "escribe"); self.assertEqual(d["effective_at"], "2026-09-08")
        by = {i.item_number: i for i in items}
        self.assertEqual(by["7.2"].action_text, "Approved 9-0"); self.assertEqual(by["7.2"].lifecycle, "Approved")
        self.assertEqual(by["7.2"].to_dict()["address_candidates"], []) if not by["7.2"].address_candidates else None
        v = [v for v in votes if v.item_id == by["7.2"].item_id][0]
        self.assertEqual(v.tally, {"yes": 9, "no": 0}); self.assertEqual(v.result, "Approved"); self.assertIsNone(v.roll_call)
        pc = [i for i in items if i.is_public_comment][0]
        self.assertIsNone(pc.action_text); self.assertEqual(pc.attachments, []); self.assertEqual(pc.address_candidates, [])
        # verbatim speaker list never reaches normalized output
        self.assertNotIn("Ian Rosenthawe", json.dumps([i.to_dict() for i in items]))
        self.assertTrue(all(c.location_confidence == "needs_review" for i in items for c in i.address_candidates))

    def test_records_from_future_agenda(self):
        now = datetime(2026, 9, 14, 12, 0, 0)
        m = self._meeting("1a03d6a7-1975-4aa5-8642-0f158777bf74", "2026-09-15", minutes=False)
        event, items, votes, docs = build_records(m, agenda=parse_meeting_html(AGENDA), minutes=None, agenda_entry=None, minutes_entry=None,
                                                  snapshot_id="run-1", observed_at="2026-09-14T01:02:03Z", now=now)
        self.assertEqual(event.status, "scheduled")
        self.assertTrue(all(i.lifecycle == "Scheduled" for i in items if not i.is_public_comment))
        self.assertEqual(votes, [])
        self.assertTrue(all(i.action_text is None for i in items))
        # passed but no minutes: still not "held"
        event2, *_ = build_records(m, agenda=parse_meeting_html(AGENDA), minutes=None, agenda_entry=None, minutes_entry=None,
                                   snapshot_id="run-1", observed_at="x", now=datetime(2026, 9, 21))
        self.assertEqual(event2.status, "scheduled"); self.assertIn("not inferred", event2.status_basis)


class LegistarTests(unittest.TestCase):
    def test_normalize_event_and_items(self):
        ev = json.loads((FIX / "legistar_events_top2.json").read_text("utf-8"))[0]
        items_json = json.loads((FIX / "legistar_eventitems_1827.json").read_text("utf-8"))
        event = normalize_event(ev, snapshot_id="bf", observed_at="2026-09-21T00:00:00Z", raw_sha="abc")
        self.assertEqual(event.body, "Neighborhood and Community Services Standing Committee")
        self.assertEqual(event.date, "2017-03-30"); self.assertEqual(event.status, "held")
        self.assertEqual(event.to_dict()["source_id"], "legistar")
        items, votes, docs = normalize_items(event, items_json, snapshot_id="bf", observed_at="2026-09-21T00:00:00Z", raw_sha="abc")
        self.assertEqual(len(items), len(items_json))
        self.assertTrue(all(i.lifecycle in LIFECYCLES for i in items))
        self.assertTrue(all(i.to_dict()["limitations"] == config.LIMITATIONS for i in items))
        with_file = [i for i in items if i.file_number]
        self.assertTrue(with_file, "expected at least one item with a MatterFile number")


class PdfTextTests(unittest.TestCase):
    def test_page_referenced_text(self):
        pages, status = extract_pages(FIX / "legistar_agenda_1827.pdf")
        self.assertEqual(status, "extracted")
        self.assertEqual([p["page"] for p in pages], [1, 2, 3])
        self.assertIn("Neighborhood and Community Services", pages[0]["text"])


if __name__ == "__main__":
    unittest.main()
