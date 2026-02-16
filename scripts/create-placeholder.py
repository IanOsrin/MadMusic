#!/usr/bin/env python3
"""Create a small optimized placeholder image"""
from PIL import Image, ImageDraw, ImageFont
import os

# Create 300x300 image (small but clean)
img = Image.new('RGB', (300, 300), color='#17181c')
draw = ImageDraw.Draw(img)

# Add gradient effect using rectangles
for i in range(300):
    color_val = int(23 + (i / 300) * 13)  # Gradient from #17181c to #24262c
    draw.rectangle([(i, 0), (i+1, 300)], fill=(color_val, color_val, color_val + 4))

# Add simple music note icon
draw.ellipse([120, 140, 180, 200], outline='#62f5a9', width=2)
draw.line([(175, 150), (175, 100)], fill='#62f5a9', width=3)
draw.ellipse([165, 95, 185, 115], fill='#62f5a9')

# Add text
try:
    draw.text((150, 230), "No Artwork", fill='#62f5a9', anchor="mm")
except:
    pass  # Font might not support anchor

# Save with optimization
output_path = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'placeholder-new.png')
img.save(output_path, 'PNG', optimize=True, quality=85)
print(f"✓ Created optimized placeholder: {output_path}")

# Check size
size = os.path.getsize(output_path)
print(f"✓ Size: {size / 1024:.1f}KB (was 4.4MB)")
