![Chickens](http://farm-cam.s3.amazonaws.com/opengraph.jpg "Chickens")

# Chicken Cam

Chicken cam is a webcam proxy/cache thing I wrote for our [chicken cam](http://chicken-cam.herokuapp.com/) at Buttercup farm.  It polls an endpoint on an interval to request a JPEG, which it then stores in memory and serves out to HTTP clients.  Kind of a multicast for JPEG's.  Or something.

Project outline is on the blog; http://www.velvetcache.org/2013/10/08/building-the-chicken-cam

# But why not use...

Seriously, finish that sentence.  I'd like to know what I could have used that would have been better, this felt a bit like re-inventing the wheel.  Varnish or something probably.

# License (MIT)

Copyright (C) 2013 John Hobbs

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
