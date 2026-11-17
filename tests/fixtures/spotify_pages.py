"""Exercise the production paging loop without importing or contacting Spotify."""

import importlib.util
import sys
import unittest

spec = importlib.util.spec_from_file_location("musicdl_pages", sys.argv.pop(1))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class Pager:
    def __init__(self, count, transform=None):
        self.count = count
        self.transform = transform
        self.offsets = []

    def get_playlist_info(self, limit, offset):
        self.offsets.append(offset)
        result = {"data": {"playlistV2": {
            "name": "Collection", "revisionId": "snapshot",
            "ownerV2": {"data": {"name": "Creator"}},
            "content": {"totalCount": self.count, "pagingInfo": {"offset": offset},
                        "items": list(range(offset, min(self.count, offset + limit)))},
        }}}
        return self.transform(result, offset) if self.transform else result


class PagingTests(unittest.TestCase):
    def test_small_and_large_complete_collections(self):
        for count in (0, 2, 1000):
            with self.subTest(count=count):
                pager = Pager(count)
                progress = []
                result = adapter.collect_playlist(pager, lambda *args: progress.append(args))
                self.assertEqual(result["entries"], list(range(count)))
                self.assertEqual(result["total"], count)
                self.assertTrue(result["complete"])
                self.assertEqual(result["creator"], "Creator")
                self.assertEqual(progress[-1], (count, count))
                self.assertEqual(pager.offsets, [0, 343, 686] if count == 1000 else [0])

    def test_rejects_partial_or_changed_pages(self):
        def changed(field, value):
            def transform(result, offset):
                if offset:
                    playlist = result["data"]["playlistV2"]
                    if field == "revisionId":
                        playlist[field] = value
                    else:
                        playlist["content"][field] = value
                return result
            return transform

        for transform in (
            changed("items", []), changed("totalCount", 999),
            changed("revisionId", "other-snapshot"),
            changed("pagingInfo", {"offset": 0}), changed("totalCount", None),
        ):
            with self.subTest(transform=transform):
                with self.assertRaisesRegex(Exception, "Incomplete metadata"):
                    adapter.collect_playlist(Pager(1000, transform), lambda *_: None)

    def test_denied_access_is_an_error(self):
        with self.assertRaisesRegex(Exception, "unavailable|accessible"):
            adapter.collect_playlist(Pager(1, lambda *_: {"errors": []}), lambda *_: None)

    def test_provider_error_is_not_swallowed(self):
        class Broken:
            def get_playlist_info(self, **_):
                raise ConnectionError("network interrupted")
        with self.assertRaises(ConnectionError):
            adapter.collect_playlist(Broken(), lambda *_: None)


if __name__ == "__main__":
    unittest.main()
