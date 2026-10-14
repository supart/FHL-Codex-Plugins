import tempfile
import unittest
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import green_screen_processor as processor


class GreenScreenProcessorTests(unittest.TestCase):
    def fixture(self, rgba=False):
        image = Image.new("RGBA" if rgba else "RGB", (64, 64), (0, 255, 0, 255) if rgba else (0, 255, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((16, 16, 47, 47), fill=(255, 255, 255, 255) if rgba else (255, 255, 255))
        draw.rectangle((28, 28, 35, 35), fill=(0, 220, 0, 255) if rgba else (0, 220, 0))
        return image

    def test_edge_green_removed_and_inner_green_kept(self):
        output, metrics = processor.remove_green(self.fixture(), 100, 0.08, 2)
        self.assertEqual(output.mode, "RGBA")
        self.assertEqual(metrics["status"], "passed")
        self.assertEqual(output.getpixel((0, 0))[3], 0)
        self.assertGreater(output.getpixel((30, 30))[3], 0)

    def test_existing_alpha_is_preserved(self):
        image = self.fixture(rgba=True)
        image.putpixel((20, 20), (255, 255, 255, 80))
        output, _ = processor.remove_green(image, 100, 0.08, 0)
        self.assertEqual(output.getpixel((20, 20))[3], 80)

    def test_split_grid_count_and_upload_size(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "grid.png"
            image = Image.new("RGB", (240, 360), (0, 255, 0))
            draw = ImageDraw.Draw(image)
            for row in range(6):
                for col in range(4):
                    x, y = col * 60, row * 60
                    draw.rectangle((x + 15, y + 15, x + 45, y + 45), fill="white")
            image.save(source)
            args = type("Args", (), {"green_threshold": 100, "spill_threshold": 0.08, "edge_feather": 2})()
            records = processor.split_grid(source, root / "out", 4, 6, [], args)
            self.assertEqual(len(records), 24)
            self.assertEqual(len(list((root / "out" / "upload_512").glob("*.png"))), 24)
            self.assertTrue(all(Image.open(path).size == (512, 512) for path in (root / "out" / "upload_512").glob("*.png")))


if __name__ == "__main__":
    unittest.main()
